/**
 * @license
 * Copyright 2014, Ian Gulliver
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

// We use long keys in many places. Provide a method to trim those down for
// human readability.
String.prototype.hashCode = function() {
  var hash = 0;
  for (i = 0; i < this.length; i++) {
    var char = this.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return hash;
};

/**
 * @constructor
 * @param {Object=} callbacks Callback dictionary
 * @param {string=} urlPrefix Absolute URL prefix for generating API URL
 * @param {string=} namespace Prefix for localStorage entries.
 */
Cosmopolite = function(callbacks, urlPrefix, namespace) {
  this.callbacks_ = callbacks || {};
  this.urlPrefix_ = urlPrefix || '/cosmopolite';
  this.namespace_ = namespace || 'cosmopolite';

  this.ready_ = false;
  this.shutdown_ = false;

  this.subscriptions_ = {};

  var scriptUrls = [
    'https://ajax.googleapis.com/ajax/libs/jquery/2.1.0/jquery.min.js',
    '/_ah/channel/jsapi',
  ];
  this.numScriptsToLoad_ = scriptUrls.length;
  scriptUrls.forEach(function(scriptUrl) {
    var script = document.createElement('script');
    script.src = scriptUrl;
    script.onload = this.onLoad_.bind(this);
    document.body.appendChild(script);
  }, this);
};

/**
 * Shutdown this instance.
 *
 * No callbacks will fire after this returns.
 */
Cosmopolite.prototype.shutdown = function() {
  console.log(this.loggingPrefix_(), 'shutdown');
  this.shutdown_ = true;
  if (this.socket_) {
    this.socket_.close();
  }
  if (this.messageHandler_) {
    window.removeEventListener('message', this.messageHandler_);
  }
};

/**
 * Subscribe to a subject.
 *
 * Start receiving messages sent to this subject via the onMessage callback.
 *
 * @param {!string} subject Subject name
 * @param {!number} messages Number of recent messages to request; 0 for none, -1 for all
 * @param {Array.<string>=} keys Key names to ensure we receive at least 1 message defining
 */
Cosmopolite.prototype.subscribe = function(subject, messages, keys) {
  if (!this.ready_) {
    throw "cosmopolite: not ready";
  }
  keys = keys || [];
  if (subject in this.subscriptions_) {
    console.log(
      this.loggingPrefix_(),
      'not sending duplication subscription request for subject:', subject);
    return;
  }
  this.subscriptions_[subject] = {
    'messages': [],
    'keys': {},
  };
  this.sendRPC_('subscribe', {
    'subject': subject,
    'messages': messages,
    'keys': keys,
  });
};

/**
 * Unsubscribe from a subject and destroy all listeners.
 *
 * Note that no reference counting is done, so a single call to unsubscribe()
 * undoes multiple calls to subscribe().
 *
 * @param {!string} subject Subject name, as passed to subscribe()
 */
Cosmopolite.prototype.unsubscribe = function(subject) {
  if (!this.ready_) {
    throw "cosmopolite: not ready";
  }
  delete this.subscriptions_[subject];
  this.sendRPC_('unsubscribe', {
    'subject': subject,
  });
};

/**
 * Post a message to the given subject, storing it and notifying all listeners.
 *
 * @param {!string} subject Subject name
 * @param {!*} message Message string or object
 * @param {string=} key Key name to associate this message with
 */
Cosmopolite.prototype.sendMessage = function(subject, message, key) {
  if (!this.ready_) {
    throw "cosmopolite: not ready";
  }
  var args = {
    'subject':           subject,
    'message':           JSON.stringify(message),
    'sender_message_id': this.uuid_(),
  };
  if (key) {
    args['key'] = key;
  }
  this.sendRPC_('sendMessage', args);
};

/**
 * Fetch all received messages for a subject
 *
 * @param {!string} subject Subject name
 * @const
 */
Cosmopolite.prototype.getMessages = function(subject) {
  if (!this.ready_) {
    throw "cosmopolite: not ready";
  }
  return this.subscriptions_[subject].messages;
};

/**
 * Fetch the most recent message that defined a key
 *
 * @param {!string} subject Subject name
 * @param {!string} key Key name
 * @const
 */
Cosmopolite.prototype.getKeyMessage = function(subject, key) {
  if (!this.ready_) {
    throw "cosmopolite: not ready";
  }
  return this.subscriptions_[subject].keys[key];
};

/**
 * Return our current profile ID, if known.
 *
 * @return {?string} Profile ID.
 * @const
 */
Cosmopolite.prototype.profile = function() {
  return this.profile_ || null;
};

/**
 * Generate a string identifying us to be included in log messages.
 *
 * @return {string} Log line prefix.
 * @const
 */
Cosmopolite.prototype.loggingPrefix_ = function() {
  return 'cosmopolite (' + this.namespace_ + '):';
};

/**
 * Generate a v4 UUID.
 *
 * @return {string} A universally-unique random value.
 * @const
 */
Cosmopolite.prototype.uuid_ = function() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    var r = (Math.random() * 16) | 0;
    if (c == 'x') {
      return r.toString(16);
    } else {
      return (r & (0x03 | 0x08)).toString(16);
    }
  });
};

/**
 * Callback when a script loads.
 */
Cosmopolite.prototype.onLoad_ = function() {
  if (--this.numScriptsToLoad_ > 0) {
    return;
  }
  // jQuery.noConflict() doesn't actually remove window.$ and window.jQuery,
  // it just sets them back to undefined. This angers QUnit's globals
  // detection. goog.appengine.Channel doesn't even provide a noConflict()
  // equivalent.
  this.$ = jQuery.noConflict(true);
  if (this.shutdown_) {
    // Shutdown during startup
    return;
  }
  this.registerMessageHandlers_();
  this.createChannel_();
};

/**
 * Callback for a message from another browser window
 *
 * @param {!string} data Message contents
 */
Cosmopolite.prototype.onReceiveMessage_ = function(data) {
  switch (data) {
    case 'login_complete':
      if (this.socket_) {
        this.socket_.close();
      }
      break;
    case 'logout_complete':
      localStorage.removeItem(this.namespace_ + ':client_id');
      localStorage.removeItem(this.namespace_ + ':google_user_id');
      if (this.socket_) {
        this.socket_.close();
      }
      break;
    default:
      console.log(this.loggingPrefix_(), 'unknown event type:', data);
      break;
  }
};

/**
 * Register onReceiveMessage to receive callbacks
 *
 * Note that we share this bus with at least the channel code, so spurious
 * messages are normal.
 */
Cosmopolite.prototype.registerMessageHandlers_ = function() {
  this.messageHandler_ = function(e) {
    if (e.origin != window.location.origin) {
      // Probably talkgadget
      return;
    }
    console.log(this.loggingPrefix_(), 'received browser message:', e.data);
    this.onReceiveMessage_(e.data);
  }.bind(this);
  window.addEventListener('message', this.messageHandler_);
};

/**
 * Send a single RPC to the server.
 *
 * See sendRPCs_()
 *
 * @param {!string} command Command name to call
 * @param {!Object} args Arguments to pass to server
 * @param {function(Object)=} onSuccess Success callback function
 */
Cosmopolite.prototype.sendRPC_ = function(command, args, onSuccess) {
  this.sendRPCs_([
    {
      'command': command,
      'arguments': args,
      'onSuccess': onSuccess,
    }
  ]);
};

/**
 * Send one or more RPCs to the server.
 *
 * Wraps handling of authentication to the server, even in cases where we need
 * to retry with more data. Also retries in cases of failure with exponential
 * backoff.
 *
 * @param {!Array.<{command:string, arguments:Object, onSuccess:function(Object)}>} commands List of commands to execute
 * @param {number=} delay Seconds waited before executing this call (for backoff)
 */
Cosmopolite.prototype.sendRPCs_ = function(commands, delay) {
  var request = {
    'commands': [],
  };
  commands.forEach(function(command) {
    var request_command = {
      'command': command['command'],
    };
    if ('arguments' in command) {
      request_command['arguments'] = command['arguments'];
    }
    request.commands.push(request_command);
  });
  if (this.namespace_ + ':client_id' in localStorage) {
    request['client_id'] = localStorage[this.namespace_ + ':client_id'];
  }
  if (this.namespace_ + ':google_user_id' in localStorage) {
    request['google_user_id'] = localStorage[this.namespace_ + ':google_user_id'];
  }
  this.$.ajax({
    url: this.urlPrefix_ + '/api',
    type: 'post',
    data: JSON.stringify(request),
    dataType: 'json',
    context: this,
  })
    .done(function(data, stat, xhr) {
      if ('google_user_id' in data) {
        localStorage[this.namespace_ + ':google_user_id'] =
          data['google_user_id'];
      }
      if ('client_id' in data) {
        localStorage[this.namespace_ + ':client_id'] = data['client_id'];
      }
      if (data['status'] == 'retry') {
        // Discard delay
        this.sendRPCs_(commands);
        return;
      }
      if (data['status'] != 'ok') {
        console.log(this.loggingPrefix_(),
          'server returned unknown status:', data['status']);
        // TODO(flamingcow): Refresh the page? Show an alert?
        return;
      }
      for (var i = 0; i < data['responses'].length; i++) {
        if (commands[i]['onSuccess']) {
          commands[i]['onSuccess'].bind(this)(data['responses'][i]);
        }
      }
      // Handle events that were immediately available as if they came over the
      // channel.
      data['events'].forEach(this.onServerEvent_, this);
    })
    .fail(function(xhr) {
      var intDelay =
        xhr.getResponseHeader('Retry-After') ||
        Math.min(32, Math.max(2, delay || 2));
      console.log(
        this.loggingPrefix_(),
        'RPC failed; will retry in ' + intDelay + ' seconds');
      function retry() {
        this.sendRPCs_(commands, Math.pow(intDelay, 2));
      }
      window.setTimeout(retry.bind(this), intDelay * 1000);
    });
};

/**
 * Send RPCs to create a server -> client channel and (re-)subscribe to subjects
 */
Cosmopolite.prototype.createChannel_ = function() {
  var rpcs = [
    {
      'command':   'createChannel',
      'onSuccess': this.onCreateChannel_,
    },
  ];
  // TODO(flamingcow): Need to restart from the latest message.
  for (var subject in this.subscriptions_) {
    rpcs.push({
      'command': 'subscribe',
      'arguments': {
        'subject':  subject,
        'messages': 0,
      }
    });
  }
  this.sendRPCs_(rpcs);
};

/**
 * Callback for channel creation on the server side
 *
 * @suppress {missingProperties}
 *
 * @param {!Object} data Server response including channel token
 */
Cosmopolite.prototype.onCreateChannel_ = function(data) {
  if (this.shutdown_) {
    return;
  }
  if (!this.ready_) {
    this.ready_ = true;
    if ('onReady' in this.callbacks_) {
      this.callbacks_['onReady']();
    }
  }
  var channel = new goog.appengine.Channel(data['token']);
  console.log(this.loggingPrefix_(), 'opening channel:', data['token']);
  this.socket_ = channel.open({
    onopen: this.onSocketOpen_.bind(this),
    onclose: this.onSocketClose_.bind(this),
    onmessage: this.onSocketMessage_.bind(this),
    onerror: this.onSocketError_.bind(this),
  });
};

/**
 * Callback from channel library for successful open
 */
Cosmopolite.prototype.onSocketOpen_ = function() {
  console.log(this.loggingPrefix_(), 'channel opened');
  if (this.shutdown_ && this.socket_) {
    this.socket_.close();
  };
};

/**
 * Callback from channel library for closure; reopen.
 */
Cosmopolite.prototype.onSocketClose_ = function() {
  console.log(this.loggingPrefix_(), 'channel closed');
  if (this.shutdown_) {
    return;
  }
  this.createChannel_();
};

/**
 * Callback from channel library for message reception over channel
 *
 * @param {!Object} msg Message contents
 */
Cosmopolite.prototype.onSocketMessage_ = function(msg) {
  this.onServerEvent_(JSON.parse(msg.data));
};

/**
 * Callback for Cosmopolite event (received via channel or pseudo-channel)
 *
 * @param {!Object} e Deserialized event object
 */
Cosmopolite.prototype.onServerEvent_ = function(e) {
  if (this.shutdown_) {
    return;
  }
  if (e['profile']) {
    this.profile_ = e['profile'];
  }
  switch (e['event_type']) {
    case 'login':
      if ('onLogin' in this.callbacks_) {
        this.callbacks_['onLogin'](
            e['google_user'],
            this.urlPrefix_ + '/auth/logout');
      }
      break;
    case 'logout':
      if ('onLogout' in this.callbacks_) {
        this.callbacks_['onLogout'](
          this.urlPrefix_ + '/auth/login');
      }
      break;
    case 'message':
      var subscription = this.subscriptions_[e['subject']];
      if (!subscription) {
        console.log(
          this.loggingPrefix_(),
          'message from unrecognized subject:', e);
        break;
      }
      var duplicate = subscription.messages.some(function(message) {
        return message['id'] == e.id;
      });
      if (duplicate) {
        console.log(this.loggingPrefix_(), 'duplicate message:', e);
        break;
      }
      e['message'] = JSON.parse(e['message']);
      subscription.messages.push(e);
      if (e['key']) {
        subscription.keys[e['key']] = e;
      }
      if ('onMessage' in this.callbacks_) {
        this.callbacks_['onMessage'](e);
      }
      break;
    default:
      // Client out of date? Force refresh?
      console.log(this.loggingPrefix_(), 'unknown channel event:', e);
      break;
  }
};

/**
 * Callback from channel library for error on channel
 *
 * @param {!string} msg Descriptive text
 */
Cosmopolite.prototype.onSocketError_ = function(msg) {
  console.log(this.loggingPrefix_(), 'socket error:', msg);
  if (this.socket_) {
    this.socket_.close();
  }
};

/* Exported values */
window.Cosmopolite = Cosmopolite;
