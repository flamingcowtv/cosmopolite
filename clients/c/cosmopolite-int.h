#ifndef _COSMOPOLITE_INT_H
#define _COSMOPOLITE_INT_H

// Declarations that aren't in the public API but are available to the test suite.

struct cosmo_command {
  struct cosmo_command *prev;
  struct cosmo_command *next;
  json_t *command;
};

struct cosmo {
  char client_id[COSMO_UUID_SIZE];
  char instance_id[COSMO_UUID_SIZE];
  cosmo_callbacks callbacks;
  cosmo_options options;
  void *passthrough;

  pthread_mutex_t lock;
  pthread_cond_t cond;
  bool shutdown;
  char *profile;
  char *generation;
  struct cosmo_command *command_queue_head;
  struct cosmo_command *command_queue_tail;
  json_t *ack;
  json_t *subscriptions;
  uint64_t next_delay_ms;
  unsigned int seedp;
  bool debug;

  enum {
    INITIAL_CONNECT,
    CONNECTED,
    DISCONNECTED,
  } connect_state;
  struct timespec last_success;

  enum {
    LOGIN_UNKNOWN,
    LOGGED_OUT,
    LOGGED_IN,
  } login_state;

  pthread_t thread;
  CURL *curl;
};

#endif
