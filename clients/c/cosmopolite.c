#include <assert.h>
#include <errno.h>
#include <math.h>
#include <stdio.h>
#include <string.h>
#include <strings.h>
#include <time.h>

#include <uuid/uuid.h>

#include "cosmopolite.h"

#define COSMO_CHECK_SECONDS 10

#define min(a, b) ((a) < (b) ? (a) : (b))
#define max(a, b) ((a) > (b) ? (a) : (b))

#define DELAY_MIN_MS 250
#define DELAY_MAX_MS 32000
#define DELAY_EXPONENT 1.1
#define DELAY_STAGGER_FACTOR 10

typedef struct {
  char *send_buf;
  size_t send_buf_len;

  char *recv_buf;
  size_t recv_buf_len;

  int64_t retry_after;
} cosmo_transfer;

static json_t *cosmo_find_subscription(cosmo *instance, json_t *subject) {
  size_t i;
  json_t *subscription;
  json_array_foreach(instance->subscriptions, i, subscription) {
    if (json_equal(json_object_get(subscription, "subject"), subject)) {
      return subscription;
    }
  }
  return NULL;
}

static size_t cosmo_read_callback(void *ptr, size_t size, size_t nmemb, void *userp) {
  cosmo_transfer *transfer = userp;
  size_t to_write = min(transfer->send_buf_len, size * nmemb);
  memcpy(ptr, transfer->send_buf, to_write);
  transfer->send_buf += to_write;
  transfer->send_buf_len -= to_write;
  return to_write;
}

static size_t cosmo_write_callback(void *ptr, size_t size, size_t nmemb, void *userp) {
  cosmo_transfer *transfer = userp;
  size_t to_read = size * nmemb;
  transfer->recv_buf = realloc(transfer->recv_buf, transfer->recv_buf_len + to_read + 1);
  assert(transfer->recv_buf);
  memcpy(transfer->recv_buf + transfer->recv_buf_len, ptr, to_read);
  transfer->recv_buf_len += to_read;
  transfer->recv_buf[transfer->recv_buf_len] = '\0';
  return to_read;
}

static size_t cosmo_header_callback(char *ptr, size_t size, size_t nmemb, void *userp) {
  cosmo_transfer *transfer = userp;
  size_t length = size * nmemb;
#define RETRY_AFTER_HEADER "Retry-After: 0\r\n"
#define RETRY_AFTER_HEADER_SIZE (sizeof(RETRY_AFTER_HEADER) - 1)
  if (length == RETRY_AFTER_HEADER_SIZE &&
      strncasecmp(ptr, RETRY_AFTER_HEADER, RETRY_AFTER_HEADER_SIZE) == 0) {
    transfer->retry_after = 0;
  }
  return length;
}

static char *cosmo_build_rpc(const cosmo *instance, const json_t *commands) {
  json_t *to_send = json_pack("{sssssO}", "client_id", instance->client_id, "instance_id", instance->instance_id, "commands", commands);
  assert(to_send);
  char *ret = json_dumps(to_send, 0);
  assert(ret);
  json_decref(to_send);
  return ret;
}

static bool cosmo_send_http_int(cosmo *instance, cosmo_transfer *transfer) {
  CURLcode res;
 
  assert(!curl_easy_setopt(instance->curl, CURLOPT_POSTFIELDSIZE, transfer->send_buf_len));
  assert(!curl_easy_setopt(instance->curl, CURLOPT_READDATA, transfer));
  assert(!curl_easy_setopt(instance->curl, CURLOPT_WRITEDATA, transfer));
  assert(!curl_easy_setopt(instance->curl, CURLOPT_HEADERDATA, transfer));
  res = curl_easy_perform(instance->curl);

  if (res) {
    fprintf(stderr, "curl_easy_perform() failed: %s\n", curl_easy_strerror(res));
    return false;
  }

  long return_code;
  assert(curl_easy_getinfo(instance->curl, CURLINFO_RESPONSE_CODE, &return_code) == CURLE_OK);
  if (return_code != 200) {
    fprintf(stderr, "server returned error: %ld\n", return_code);
    return false;
  }

  return true;
}

// Takes ownership of request.
static char *cosmo_send_http(cosmo *instance, char *request) {
  cosmo_transfer transfer = {
    .send_buf = request,
    .send_buf_len = strlen(request),
    .recv_buf = NULL,
    .recv_buf_len = 0,
    .retry_after = -1
  };

  int ret = cosmo_send_http_int(instance, &transfer);

  if (transfer.retry_after >= 0) {
    instance->next_delay_ms = transfer.retry_after * 1000;
  }

  free(request);

  return ret ? transfer.recv_buf : NULL;
}

static void cosmo_handle_message(cosmo *instance, json_t *event) {
  json_t *subject = json_object_get(event, "subject");
  if (!subject) {
    fprintf(stderr, "message event without subject\n");
    return;
  }

  json_t *id_json = json_object_get(event, "id");
  if (!id_json) {
    fprintf(stderr, "message event without id\n");
    return;
  }
  json_int_t id = json_integer_value(id_json);

  assert(!pthread_mutex_lock(&instance->lock));
  json_t *subscription = cosmo_find_subscription(instance, subject);
  if (!subscription) {
    fprintf(stderr, "message from unknown subject\n");
    assert(!pthread_mutex_unlock(&instance->lock));
    return;
  }
  json_t *messages = json_object_get(subscription, "messages");
  ssize_t insert_after;
  for (insert_after = json_array_size(messages) - 1; insert_after >= 0; insert_after--) {
    json_t *message = json_array_get(messages, insert_after);
    json_int_t message_id = json_integer_value(json_object_get(message, "id"));
    if (message_id == id) {
      assert(!pthread_mutex_unlock(&instance->lock));
      return;
    }
    if (message_id < id) {
      break;
    }
  }
  json_array_insert(messages, insert_after + 1, event);
  assert(!pthread_mutex_unlock(&instance->lock));

  if (instance->callbacks.message) {
    instance->callbacks.message(event);
  }
}

static void cosmo_handle_event(cosmo *instance, json_t *event) {
  const char *event_type = json_string_value(json_object_get(event, "event_type"));
  if (strcmp(event_type, "message") == 0) {
    cosmo_handle_message(instance, event);
  } else {
    fprintf(stderr, "unknown event type: %s\n", event_type);
  }
}

// Takes ownership of commands.
static json_t *cosmo_send_rpc(cosmo *instance, json_t *commands) {
  char *request = cosmo_build_rpc(instance, commands);

  char *response = cosmo_send_http(instance, request);
  if (!response) {
    return commands;
  }

  json_error_t error;
  json_t *received = json_loads(response, 0, &error);
  if (!received) {
    fprintf(stderr, "json_loads() failed: %s (json: \"%s\")\n", error.text, response);
    free(response);
    return commands;
  }
  free(response);

  json_t *profile = json_object_get(received, "profile");
  if (profile) {
    if (!instance->profile || strcmp(instance->profile, json_string_value(profile))) {
      free(instance->profile);
      instance->profile = strdup(json_string_value(profile));
    }
  } else {
    fprintf(stderr, "response lacks \"profile\" key\n");
  }

  json_t *command_responses = json_object_get(received, "responses");
  if (!command_responses) {
    fprintf(stderr, "response lacks \"responses\" key\n");
    return commands;
  }

  size_t index;

  json_t *events = json_object_get(received, "events");
  if (events) {
    json_t *event;
    json_array_foreach(events, index, event) {
      cosmo_handle_event(instance, event);
    }
  }

  json_t *to_retry = json_array();
  json_t *command;
  json_array_foreach(commands, index, command) {
    json_t *command_response = json_array_get(command_responses, index);
    json_t *result = json_object_get(command_response, "result");
    if (!result) {
      fprintf(stderr, "response lacks \"result\" key\n");
      json_array_append(to_retry, command);
      continue;
    }
    if (!strcmp(json_string_value(result), "retry")) {
      // One giant hack to change queued subscribe messages to ask for less data.
      // Remove this once we get channels working; it's not worth the yuck.
      const char *name = json_string_value(json_object_get(command, "command"));
      if (!strcmp(name, "subscribe")) {
        json_t *arguments = json_object_get(command, "arguments");
        json_t *subject = json_object_get(arguments, "subject");
        json_t *last_message = cosmo_get_last_message(instance, subject);
        if (last_message) {
          json_t *last_id = json_object_get(arguments, "last_id");
          json_int_t last_id_val = last_id ? json_integer_value(last_id) : 0;
          json_int_t local_last_id = json_integer_value(json_object_get(last_message, "id"));
          if (local_last_id > last_id_val) {
            json_object_del(arguments, "messages");
            json_object_set_new(arguments, "last_id", json_integer(local_last_id));
          }
          json_decref(last_message);
        }
      }
      json_array_append(to_retry, command);
      continue;
    }
  }
  json_decref(commands);

  json_decref(received);

  return to_retry;
}

static void *cosmo_thread_main(void *arg) {
  cosmo *instance = arg;

  assert(!pthread_mutex_lock(&instance->lock));
  while (!instance->shutdown) {
    if (json_array_size(instance->command_queue)) {
      json_t *commands = instance->command_queue;
      instance->command_queue = json_array();
      instance->next_delay_ms = pow(instance->next_delay_ms, DELAY_EXPONENT);
      instance->next_delay_ms = min(DELAY_MAX_MS, max(DELAY_MIN_MS, instance->next_delay_ms));
      instance->next_delay_ms += random() % (instance->next_delay_ms / DELAY_STAGGER_FACTOR);

      assert(!pthread_mutex_unlock(&instance->lock));
      json_t *to_retry = cosmo_send_rpc(instance, commands);
      assert(!pthread_mutex_lock(&instance->lock));

      json_array_extend(instance->command_queue, to_retry);
      json_decref(to_retry);
    }

    if (json_array_size(instance->command_queue)) {
      struct timeval tv;
      assert(!gettimeofday(&tv, NULL));

      struct timespec ts;
      if (tv.tv_usec + ((instance->next_delay_ms % 1000) * 1000) > 1000000) {
        // Carry
        ts.tv_sec = tv.tv_sec + (instance->next_delay_ms / 1000) + 1;
        ts.tv_nsec = (tv.tv_usec * 1000) + ((instance->next_delay_ms % 1000) * 1000000) - 1000000000;
      } else {
        ts.tv_sec = tv.tv_sec + (instance->next_delay_ms / 1000);
      }

      int wait = pthread_cond_timedwait(&instance->cond, &instance->lock, &ts);
      assert(wait == 0 || wait == ETIMEDOUT);
    } else {
      assert(!pthread_cond_wait(&instance->cond, &instance->lock));
    }
  }
  assert(!pthread_mutex_unlock(&instance->lock));
  return NULL;
}

// Takes ownership of command.
static void cosmo_send_command(cosmo *instance, json_t *command) {
  assert(command);
  assert(!pthread_mutex_lock(&instance->lock));
  json_array_append_new(instance->command_queue, command);
  instance->next_delay_ms = 0;
  assert(!pthread_cond_signal(&instance->cond));
  assert(!pthread_mutex_unlock(&instance->lock));
}

// Takes ownership of arguments.
static json_t *cosmo_command(const char *name, const json_t *arguments) {
  return json_pack("{ssso}", "command", name, "arguments", arguments);
}


// Public interface below

void cosmo_uuid(char *uuid) {
  uuid_t uu;
  uuid_generate(uu);
  uuid_unparse_lower(uu, uuid);
}

const char *cosmo_current_profile(cosmo *instance) {
  return instance->profile;
}

json_t *cosmo_subject(const char *name, const char *readable_only_by, const char *writeable_only_by) {
  json_t *ret = json_pack("{ss}", "name", name);
  if (readable_only_by) {
    json_object_set_new(ret, "readable_only_by", json_string(readable_only_by));
  }
  if (writeable_only_by) {
    json_object_set_new(ret, "writeable_only_by", json_string(writeable_only_by));
  }
  return ret;
}

void cosmo_subscribe(cosmo *instance, json_t *subject, const json_int_t messages, const json_int_t last_id) {
  json_t *arguments = json_pack("{sO}", "subject", subject);
  if (messages) {
    json_object_set_new(arguments, "messages", json_integer(messages));
  }
  if (last_id) {
    json_object_set_new(arguments, "last_id", json_integer(last_id));
  }

  assert(!pthread_mutex_lock(&instance->lock));
  json_t *subscription = cosmo_find_subscription(instance, subject);
  if (!subscription) {
    json_array_append_new(instance->subscriptions, json_pack("{sOs[]}", "subject", subject, "messages"));
  }
  assert(!pthread_mutex_unlock(&instance->lock));

  cosmo_send_command(instance, cosmo_command("subscribe", arguments));
}

void cosmo_unsubscribe(cosmo *instance, json_t *subject) {
  assert(!pthread_mutex_lock(&instance->lock));
  size_t i;
  json_t *subscription;
  json_array_foreach(instance->subscriptions, i, subscription) {
    if (json_equal(json_object_get(subscription, "subject"), subject)) {
      json_array_remove(instance->subscriptions, i);
      break;
    }
  }
  assert(!pthread_mutex_unlock(&instance->lock));

  json_t *arguments = json_pack("{sO}", "subject", subject);
  cosmo_send_command(instance, cosmo_command("unsubscribe", arguments));
}

void cosmo_send_message(cosmo *instance, json_t *subject, json_t *message) {
  char sender_message_id[COSMO_UUID_SIZE];
  cosmo_uuid(sender_message_id);
  char *encoded = json_dumps(message, JSON_ENCODE_ANY);
  json_t *arguments = json_pack("{sOssss}",
      "subject", subject,
      "message", encoded,
      "sender_message_id", sender_message_id);
  cosmo_send_command(instance, cosmo_command("sendMessage", arguments));
  free(encoded);
}

json_t *cosmo_get_messages(cosmo *instance, json_t *subject) {
  assert(!pthread_mutex_lock(&instance->lock));
  json_t *subscription = cosmo_find_subscription(instance, subject);
  if (!subscription) {
    assert(!pthread_mutex_unlock(&instance->lock));
    return NULL;
  }
  json_t *messages = json_object_get(subscription, "messages");
  json_t *ret = json_deep_copy(messages);
  assert(!pthread_mutex_unlock(&instance->lock));

  return ret;
}

json_t *cosmo_get_last_message(cosmo *instance, json_t *subject) {
  assert(!pthread_mutex_lock(&instance->lock));
  json_t *subscription = cosmo_find_subscription(instance, subject);
  if (!subscription) {
    assert(!pthread_mutex_unlock(&instance->lock));
    return NULL;
  }
  json_t *messages = json_object_get(subscription, "messages");
  json_t *last_message = json_array_get(messages, json_array_size(messages) - 1);
  json_t *ret = json_deep_copy(last_message);
  assert(!pthread_mutex_unlock(&instance->lock));

  return ret;
}

cosmo *cosmo_create(const char *base_url, const char *client_id, const cosmo_callbacks *callbacks) {
  curl_global_init(CURL_GLOBAL_DEFAULT);
  srandomdev();

  cosmo *instance = malloc(sizeof(cosmo));
  assert(instance);

  strcpy(instance->client_id, client_id);
  cosmo_uuid(instance->instance_id);

  memcpy(&instance->callbacks, callbacks, sizeof(instance->callbacks));

  assert(!pthread_mutex_init(&instance->lock, NULL));
  assert(!pthread_cond_init(&instance->cond, NULL));

  instance->curl = curl_easy_init();
  assert(instance->curl);
  char api_url[strlen(base_url) + 5];
  sprintf(api_url, "%s/api", base_url);
  assert(!curl_easy_setopt(instance->curl, CURLOPT_URL, api_url));
  assert(!curl_easy_setopt(instance->curl, CURLOPT_PROTOCOLS, CURLPROTO_HTTPS));
  assert(!curl_easy_setopt(instance->curl, CURLOPT_REDIR_PROTOCOLS, CURLPROTO_HTTPS));
  assert(!curl_easy_setopt(instance->curl, CURLOPT_SSL_CIPHER_LIST, "ECDH+AESGCM:EDH+AESGCM:AES256+EECDH:AES256+EDH"));
  assert(!curl_easy_setopt(instance->curl, CURLOPT_TIMEOUT, COSMO_CHECK_SECONDS));
  assert(!curl_easy_setopt(instance->curl, CURLOPT_POST, 1L));
  assert(!curl_easy_setopt(instance->curl, CURLOPT_READFUNCTION, cosmo_read_callback));
  assert(!curl_easy_setopt(instance->curl, CURLOPT_WRITEFUNCTION, cosmo_write_callback));
  assert(!curl_easy_setopt(instance->curl, CURLOPT_HEADERFUNCTION, cosmo_header_callback));

  instance->shutdown = false;
  instance->profile = NULL;
  instance->command_queue = json_array();
  assert(instance->command_queue);
  instance->subscriptions = json_array();
  assert(instance->subscriptions);
  instance->next_delay_ms = 0;

  assert(!pthread_create(&instance->thread, NULL, cosmo_thread_main, instance));
  return instance;
}

void cosmo_shutdown(cosmo *instance) {
  pthread_mutex_lock(&instance->lock);
  instance->shutdown = true;
  instance->next_delay_ms = 0;
  pthread_cond_signal(&instance->cond);
  pthread_mutex_unlock(&instance->lock);
  assert(!pthread_join(instance->thread, NULL));

  assert(!pthread_mutex_destroy(&instance->lock));
  assert(!pthread_cond_destroy(&instance->cond));
  json_decref(instance->command_queue);
  json_decref(instance->subscriptions);
  free(instance->profile);
  curl_easy_cleanup(instance->curl);

  free(instance);

  curl_global_cleanup();
}
