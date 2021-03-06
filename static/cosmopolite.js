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


/**
 * Java-compatible hash calculation
 *
 * We use long keys in many places. Provide a method to trim those down for
 * human readability.
 *
 * @return {number}
 * @const
 */
String.prototype.hashCode = function() {
  /** @type {number} */
  var hash = 0;
  for (i = 0; i < this.length; i++) {
    var char = this.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return hash;
};



/**
 * @see https://www.cosmopolite.org/reference#constructor
 * @constructor
 * @param {?string=} opt_urlPrefix
 * @param {?string=} opt_namespace
 * @param {?string=} opt_trackingID
 */
var Cosmopolite = function(opt_urlPrefix, opt_namespace, opt_trackingID) {
  /**
   * @type {string}
   * @const
   * @private
   */
  this.urlPrefix_ = opt_urlPrefix || '/cosmopolite';
  /**
   * @type {string}
   * @const
   * @private
   */
  this.namespace_ = opt_namespace || 'cosmopolite';
  /**
   * @type {?string}
   * @const
   * @private
   */
  this.trackingID_ = opt_trackingID || null;

  /**
   * @type {Cosmopolite.ChannelState_}
   * @private
   */
  this.channelState_ = Cosmopolite.ChannelState_.CLOSED;
  /**
   * @type {boolean}
   * @private
   */
  this.shutdown_ = false;

  /**
   * @type {Object.<string, Cosmopolite.typeSubscription_>}
   * @const
   * @private
   */
  this.subscriptions_ = {};
  /**
   * @type {Object.<string, Cosmopolite.typeMessage>}
   * @const
   * @private
   */
  this.pins_ = {};
  /**
   * @type {Array.<function(string)>}
   * @const
   * @private
   */
  this.profilePromises_ = [];

  if (!localStorage[this.namespace_ + ':client_id']) {
    localStorage[this.namespace_ + ':client_id'] = this.uuid();
  }
  /**
   * @type {string}
   * @private
   */
  this.clientID_ = localStorage[this.namespace_ + ':client_id'];

  /**
   * @type {string}
   * @private
   */
  this.instanceID_ = this.uuid();

  /**
   * @type {DocumentFragment}
   * @private
   * Weep for all our souls.
   */
  this.eventTarget_ = document.createDocumentFragment();

  /**
   * @type {function(string, function(Event))}
   */
  this.addEventListener =
      this.eventTarget_.addEventListener.bind(this.eventTarget_);

  /**
   * @type {function(string, function(Event))}
   */
  this.removeEventListener =
      this.eventTarget_.removeEventListener.bind(this.eventTarget_);

  /**
   * @type {function(!Event):boolean}
   */
  this.dispatchEvent =
      this.eventTarget_.dispatchEvent.bind(this.eventTarget_);

  /**
   * @type {string}
   * @const
   * @private
   */
  this.messageQueueKey_ = this.namespace_ + ':message_queue';
  if (this.messageQueueKey_ in localStorage) {
    /** @type {Array.<Cosmopolite.typeMessage>} */
    var messages = /** @type {Array.<Cosmopolite.typeMessage>} */
        (JSON.parse(localStorage[this.messageQueueKey_]));
    if (messages.length) {
      console.log(
          this.loggingPrefix_(), '(re-)sending queued messages:', messages);
    }
    messages.forEach(function(message) {
      // We don't use sendMessage because we need to preserve the first
      // message's client_message_id, which is intentionally not exposed via
      // the sendMessage API
      this.sendRPC_(
          'sendMessage', message,
          this.onMessageSent_.bind(this, message, null, null));
    }, this);
  } else {
    localStorage[this.messageQueueKey_] = JSON.stringify([]);
  }

  /**
   * @type {string}
   * @const
   * @private
   */
  this.messageCacheKeyPrefix_ = this.namespace_ + ':message_cache:';

  if (document.readyState == 'complete') {
    this.init_();
  } else {
    document.addEventListener('readystatechange', this.init_.bind(this));
  }
};


/**
 * @typedef {{event_type: string}}
 * @private
 */
Cosmopolite.typeEvent_;


/**
 * @typedef {{event_type: string,
 *            google_user: string}}
 * @private
 */
Cosmopolite.typeLogin_;


/**
 * @typedef {{event_type: string}}
 * @private
 */
Cosmopolite.typeLogout_;


/** @typedef {{event_type: string,
               id: number,
               created: number,
               sender: string,
               subject: Cosmopolite.typeSubject,
               message: *}} */
Cosmopolite.typeMessage;


/**
 * @typedef {{command: string,
              arguments: Object,
              onSuccess: (?function(Object))}}
 * @private
 */
Cosmopolite.typeRPC_;


/** @typedef {{name: string,
               readable_only_by: (string|undefined),
               writable_only_by: (string|undefined)}} */
Cosmopolite.typeSubject;


/** @typedef {(Cosmopolite.typeSubject|string|number)} */
Cosmopolite.typeSubjectLoose;


/**
 * @typedef {{messages: Array.<Cosmopolite.typeMessage>,
              pins: Array.<Cosmopolite.typeMessage>,
              state: Cosmopolite.SubscriptionState_,
              use_cache: boolean}}
 * @private
 */
Cosmopolite.typeSubscription_;


/**
 * Channel states
 * @enum {number}
 * @private
 */
Cosmopolite.ChannelState_ = {
  // No channel open, no RPC pending
  CLOSED: 1,
  // No channel open, RPC pending
  PENDING: 2,
  // RPC complete, channel opening
  OPENING: 3,
  // Channel opened
  OPEN: 3
};


/**
 * Subscription states
 * @enum {number}
 * @private
 */
Cosmopolite.SubscriptionState_ = {
  PENDING: 1,
  ACTIVE: 2
};


/**
 * @see https://www.cosmopolite.org/reference#shutdown
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
 * @see https://www.cosmopolite.org/reference#connected
 * @return {boolean}
 */
Cosmopolite.prototype.connected = function() {
  return this.channelState_ == Cosmopolite.ChannelState_.OPEN;
};


/**
 * @see https://www.cosmopolite.org/reference#subscribe
 * @param {Cosmopolite.typeSubjectLoose|Array.<Cosmopolite.typeSubjectLoose>}
 *     subjects
 * @param {?number=} opt_messages
 * @param {?number=} opt_lastID
 * @return {Promise|Array.<Promise>}
 */
Cosmopolite.prototype.subscribe = function(subjects, opt_messages, opt_lastID) {
  var single = false;

  if (!(subjects instanceof Array)) {
    single = true;
    subjects = [subjects];
  }

  var ret = [];
  var rpcs = [];
  for (var i = 0; i < subjects.length; i++) {
    var subject = subjects[i];

    ret.push(this.newPromise_(function(resolve, reject) {
      if (subject['local'] &&
          (subject['readable_only_by'] || subject['writable_only_by'])) {
        console.log(this.loggingPrefix_(),
                    'local subjects can\'t have ACLs:', subject);
        reject(new Error('Local subject with ACL'));
        return;
      }

      /** @type {Cosmopolite.typeSubject} */
      var canonicalSubject = this.canonicalSubject_(subject);
      /** @type {string} */
      var subjectString = this.subjectString_(canonicalSubject);
      var subscription = this.subscriptions_[subjectString];
      var use_cache = false;
      if (!subscription) {
        // Initially set use_cache to false, so we can batch the first cache
        // write later.
        this.subscriptions_[subjectString] = subscription = {
          'subject': canonicalSubject,
          'messages': [],
          'pins': [],
          'state': Cosmopolite.SubscriptionState_.PENDING,
          'use_cache': false,
        };
        use_cache = (opt_messages == -1);
      }

      if (subject['local']) {
        this.subscriptions_[subjectString].state =
            Cosmopolite.SubscriptionState_.ACTIVE;
        resolve();
        return;
      }

      var args = {
        'subject': canonicalSubject
      };
      if (opt_messages) {
        args['messages'] = opt_messages;
      }
      if (opt_lastID != null) {
        args['last_id'] = opt_lastID;
      }

      if (use_cache) {
        // Load cache, fire events.
        var key = this.messageCacheKeyPrefix_ + subjectString;
        var messageStr = localStorage[key];
        if (messageStr) {
          subscription.messages =
              /** @type {Array.<Cosmopolite.typeMessage>} */ (
                  JSON.parse(messageStr));
          // Simplified version of onMessage_, to avoid a bunch of the
          // overhead.
          subscription.messages.forEach(function(msg) {
            this.dispatchEvent(new CustomEvent('message', {
              'detail': msg,
            }));
          }.bind(this));
        }
        if (subscription.messages.length > 0) {
          // Shorten our server request using the cache.
          delete args['messages'];
          args['last_id'] =
              subscription.messages[subscription.messages.length - 1]['id'];
        }
      }

      var preEvents = function(response) {
        var subscription = this.subscriptions_[subjectString];
        if (!subscription) {
          return;
        }
        subscription.pins.forEach(function(pin) {
          // Stupid hack that saves complexity elsewhere
          pin['message'] = JSON.stringify(pin['message']);
          this.onUnpin_(pin);
        }, this);
      };

      var onSuccess = function(response) {
        /** @type {string} */
        var result = response['result'];
        if (result == 'ok') {
          subscription.use_cache = use_cache;
          this.writeMessageCache_(canonicalSubject);
          // unsubscribe may have been called since we sent the RPC. That's racy
          // without waiting for the promise, but do our best
          if (subjectString in this.subscriptions_) {
            this.subscriptions_[subjectString].state =
                Cosmopolite.SubscriptionState_.ACTIVE;
          }
          resolve();
          this.trackEvent(
              'send', 'event', 'cosmopolite', 'subscribe', subjectString);
        } else {
          delete this.subscriptions_[subjectString];
          reject(new Error(result));
        }
      };
      rpcs.push({
        'command': 'subscribe',
        'arguments': args,
        'preEvents': preEvents,
        'onSuccess': onSuccess
      });
    }.bind(this)));
  }

  this.sendRPCs_(rpcs);

  if (single) {
    return ret[0];
  } else {
    return ret;
  }
};


/**
 * @see https://www.cosmopolite.org/reference#unsubscribe
 * @param {Cosmopolite.typeSubjectLoose} subject
 * @return {Promise}
 */
Cosmopolite.prototype.unsubscribe = function(subject) {
  return this.newPromise_(function(resolve, reject) {
    /** @type {Cosmopolite.typeSubject} */
    var canonicalSubject = this.canonicalSubject_(subject);
    /** @type {string} */
    var subjectString = this.subjectString_(canonicalSubject);
    delete this.subscriptions_[subjectString];
    if (subject['local']) {
      resolve();
      return;
    }
    var args = {
      'subject': canonicalSubject
    };
    this.sendRPC_('unsubscribe', args, resolve);
  }.bind(this));
};


/**
 * @see https://www.cosmopolite.org/reference#sendMessage
 * @param {Cosmopolite.typeSubjectLoose} subject
 * @param {!*} message
 * @return {Promise}
 */
Cosmopolite.prototype.sendMessage = function(subject, message) {
  return this.newPromise_(function(resolve, reject) {
    if (subject['local'] &&
        (subject['readable_only_by'] || subject['writable_only_by'])) {
      console.log(this.loggingPrefix_(),
                  'local subjects can\'t have ACLs:', subject);
      reject(new Error('Local subject with ACL'));
      return;
    }

    var args = /** @type {Cosmopolite.typeMessage} */ ({
      'subject': this.canonicalSubject_(subject),
      'message': JSON.stringify(message),
      'sender_message_id': this.uuid()
    });

    if (subject['local']) {
      resolve(message);
      args['id'] = this.uuid();
      this.onMessage_(args);
      return;
    }

    // No message left behind.
    var messageQueue = JSON.parse(localStorage[this.messageQueueKey_]);
    messageQueue.push(args);
    localStorage[this.messageQueueKey_] = JSON.stringify(messageQueue);

    this.sendRPC_(
        'sendMessage', args,
        this.onMessageSent_.bind(this, args, resolve, reject));
  }.bind(this));
};


/**
 * @see https://www.cosmopolite.org/reference#getMessages
 * @param {Cosmopolite.typeSubjectLoose} subject
 * @return {Array.<Cosmopolite.typeMessage>}
 * @const
 */
Cosmopolite.prototype.getMessages = function(subject) {
  /** @type {Cosmopolite.typeSubject} */
  var canonicalSubject = this.canonicalSubject_(subject);
  /** @type {string} */
  var subjectString = this.subjectString_(canonicalSubject);
  return this.subscriptions_[subjectString].messages;
};


/**
 * @see https://www.cosmopolite.org/reference#getLastMessage
 * @param {Cosmopolite.typeSubjectLoose} subject
 * @return {?Cosmopolite.typeMessage}
 * @const
 */
Cosmopolite.prototype.getLastMessage = function(subject) {
  /** @type {Array.<Cosmopolite.typeMessage>} */
  var messages = this.getMessages(subject);
  if (messages.length) {
    return messages[messages.length - 1];
  } else {
    return null;
  }
};


/**
 * @see https://www.cosmopolite.org/reference#getPins
 * @param {Cosmopolite.typeSubjectLoose} subject
 * @return {Array.<Cosmopolite.typeMessage>}
 * @const
 */
Cosmopolite.prototype.getPins = function(subject) {
  /** @type {Cosmopolite.typeSubject} */
  var canonicalSubject = this.canonicalSubject_(subject);
  /** @type {string} */
  var subjectString = this.subjectString_(canonicalSubject);
  return this.subscriptions_[subjectString].pins;
};


/**
 * @see https://www.cosmopolite.org/reference#getProfile
 * @return {Promise}
 */
Cosmopolite.prototype.getProfile = function() {
  return this.newPromise_(function(resolve, reject) {
    if (this.profile_) {
      resolve(this.profile_);
    } else {
      this.profilePromises_.push(resolve);
    }
  }.bind(this));
};


/**
 * @see https://www.cosmopolite.org/reference#currentProfile
 * @return {?string}
 * @const
 */
Cosmopolite.prototype.currentProfile = function() {
  return this.profile_;
};


/**
 * @see https://www.cosmopolite.org/reference#pin_method
 * @param {Cosmopolite.typeSubjectLoose} subject
 * @param {!*} message
 * @return {Promise}
 */
Cosmopolite.prototype.pin = function(subject, message) {
  return this.newPromise_(function(resolve, reject) {
    /** @type {string} */
    var id = this.uuid();
    var args = {
      'subject': this.canonicalSubject_(subject),
      'message': JSON.stringify(message),
      'sender_message_id': id
    };

    var onSuccess = function() {
      // TODO: this should check result status
      this.pins_[id] = args;
      resolve(id);
    };

    if (subject['local']) {
      onSuccess.bind(this)();
      // Ugly hack, but we need this to promise to resolve before the callback
      // fires. This is the equivalent of sched_yield(), and probably about as
      // reliable.
      var msg = /** @type {Cosmopolite.typeMessage} */ (Object.create(args));
      window.setTimeout(this.onPin_.bind(this, msg), 0);
      return;
    }

    this.sendRPC_('pin', args, onSuccess);
  }.bind(this));
};


/**
 * @see https://www.cosmopolite.org/reference#unpin
 * @param {string} id
 * @return {Promise}
 */
Cosmopolite.prototype.unpin = function(id) {
  return this.newPromise_(function(resolve, reject) {
    var pin = this.pins_[id];
    var args = {
      'subject': pin['subject'],
      'sender_message_id': pin['sender_message_id']
    };

    delete this.pins_[id];

    if (pin['subject']['local']) {
      resolve();
      var msg = /** @type {Cosmopolite.typeMessage} */ (Object.create(pin));
      window.setTimeout(this.onUnpin_.bind(this, msg), 0);
      return;
    }

    this.sendRPC_('unpin', args, resolve);
  }.bind(this));
};


/**
 * @see https://www.cosmopolite.org/reference#trackEvent
 * @param {...*} var_args
 */
Cosmopolite.prototype.trackEvent = function(var_args) {
  if (this.analyticsObj_) {
    this.analyticsObj_.apply(this, arguments);
  } else if (this.analyticsObjName_) {
    window[this.analyticsObjName_].q.push(arguments);
  }
};


/**
 * Initialization that requires the DOM.
 *
 * @private
 */
Cosmopolite.prototype.init_ = function() {
  if (document.readyState != 'complete') {
    return;
  }

  /**
   * @type {Promise}
   * @private
   */
  this.channelAPIPromise_ = this.newPromise_(function(resolve, reject) {
    var script = document.createElement('script');
    script.src = '/_ah/channel/jsapi';
    script.async = true;
    script.onload = resolve;
    document.body.appendChild(script);
  });

  if (this.trackingID_) {
    /**
     * @type {string}
     * @private
     */
    this.analyticsObjName_ = this.uuid();
    window['GoogleAnalyticsObject'] = this.analyticsObjName_;

    var completeCallback = (function() {
      /**
      * @type {function(...)}
      * @private
      */
      this.analyticsObj_ = window[this.analyticsObjName_];
      delete window[this.analyticsObjName_];
    }).bind(this);

    window[this.analyticsObjName_] = {
      'l': 1 * new Date(),
      'q': []
    };

    var script = document.createElement('script');
    script.src = 'https://www.google-analytics.com/analytics.js';
    script.async = true;
    script.onload = completeCallback;
    document.body.appendChild(script);

    this.trackEvent('create', this.trackingID_, {
      'storage': 'none',
      'clientId': localStorage[this.namespace_ + ':tracking_client_id']
    });
    this.trackEvent((function(analytics) {
      localStorage[this.namespace_ + ':tracking_client_id'] =
          analytics.get('clientId');
    }).bind(this));
    this.trackEvent('send', 'event', 'cosmopolite', 'load');
  }

  this.registerMessageHandlers_();
  this.createChannel_();
};


/**
 * @see https://www.cosmopolite.org/reference#uuid
 * @return {string}
 * @const
 */
Cosmopolite.prototype.uuid = function() {
  var randomBytes = new Uint8Array(31);
  window.crypto.getRandomValues(randomBytes);
  var i = 0;
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    /** @type {number} */
    var r = randomBytes[i++] % 16;
    if (c == 'x') {
      return r.toString(16);
    } else {
      return (r & (0x03 | 0x08)).toString(16);
    }
  });
};


/**
 * @see https://www.cosmopolite.org/reference#uuid
 * @return {string}
 */
Cosmopolite.uuid = Cosmopolite.prototype.uuid;


/**
 * Build a new Promise object with exception handling.
 *
 * @param {function(...)} callback
 *
 * @return {Promise}
 * @private
 */
Cosmopolite.prototype.newPromise_ = function(callback) {
  var promise = new Promise(callback);
  return /** @type {Promise} */ (promise.then(undefined, function(err) {
    this.trackEvent('send', 'exception', {
      'exDescription': err.message
    });
    console.log(err);
    throw err;
  }.bind(this)));
};


/**
 * Generate a string identifying us to be included in log messages.
 *
 * @return {string} Log line prefix.
 * @const
 * @private
 */
Cosmopolite.prototype.loggingPrefix_ = function() {
  if (this.instanceID_) {
    return 'cosmopolite (' + this.namespace_ + ' / ' + this.instanceID_ + '):';
  } else {
    return 'cosmopolite (' + this.namespace_ + '):';
  }
};


/**
 * Canonicalize a subject name or object
 *
 * @param {Cosmopolite.typeSubjectLoose} subject A simple or complex
 *     representation of a subject
 * @return {Cosmopolite.typeSubject} A canonicalized object for RPCs
 * @const
 * @private
 */
Cosmopolite.prototype.canonicalSubject_ = function(subject) {
  if (typeof(subject) == 'number') {
    subject = subject.toString();
  }
  if (typeof(subject) == 'string') {
    subject = {
      'name': subject
    };
  }
  if (subject['readable_only_by'] === null) {
    delete subject['readable_only_by'];
  }
  if (subject['writable_only_by'] === null) {
    delete subject['writable_only_by'];
  }
  if (!subject['local']) {
    delete subject['local'];
  }
  return subject;
};


/**
 * Stringify a subject for use as an object key.
 *
 * @param {Cosmopolite.typeSubject} subject
 * @return {string}
 * @const
 * @private
 */
Cosmopolite.prototype.subjectString_ = function(subject) {
  return [
    subject['name'],
    subject['readable_only_by'],
    subject['writable_only_by'],
    subject['local']
  ].toString();
};


/**
 * Write message cache to local storage.
 *
 * @param {Cosmopolite.typeSubject} subject
 * @const
 * @private
 */
Cosmopolite.prototype.writeMessageCache_ = function(subject) {
  var subjectString = this.subjectString_(subject);
  var subscription = this.subscriptions_[subjectString];
  if (!subscription || !subscription.use_cache) {
    return;
  }
  var key = this.messageCacheKeyPrefix_ + subjectString;
  localStorage[key] = JSON.stringify(subscription.messages);
};


/**
 * Callback for a message from another browser window
 *
 * @param {string} data
 * @private
 */
Cosmopolite.prototype.onReceiveMessage_ = function(data) {
  switch (data) {
    case 'login_complete':
      if (this.socket_) {
        this.socket_.close();
      }
      break;
    case 'logout_complete':
      this.clientID_ = localStorage[this.namespace_ + ':client_id'] =
          this.uuid();
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
 *
 * @private
 */
Cosmopolite.prototype.registerMessageHandlers_ = function() {
  /**
   * @param {Event} e
   * @this {Cosmopolite}
   */
  this.messageHandler_ = (function(e) {
    if (e.origin != window.location.origin) {
      // Probably talkgadget
      return;
    }
    console.log(this.loggingPrefix_(), 'received browser message:', e.data);
    this.onReceiveMessage_(e.data);
  }).bind(this);
  window.addEventListener('message', this.messageHandler_);
};


/**
 * Callback for a sendMessage RPC ack by the server.
 *
 * @param {Cosmopolite.typeMessage} message Message details.
 * @param {?function(Cosmopolite.typeMessage)} resolve Promise resolution
 *     callback.
 * @param {?function(Error)} reject Promise rejection callback.
 * @param {Object} response Server RPC response.
 * @private
 */
Cosmopolite.prototype.onMessageSent_ = function(
    message, resolve, reject, response) {
  // No message left behind.
  var messageQueue = JSON.parse(localStorage[this.messageQueueKey_]);
  messageQueue = messageQueue.filter(function(queuedMessage) {
    return message['sender_message_id'] != queuedMessage['sender_message_id'];
  });
  localStorage[this.messageQueueKey_] = JSON.stringify(messageQueue);
  var result = response['result'];
  if (result == 'ok' || result == 'duplicate_message') {
    if (resolve) {
      response['message']['message'] = JSON.parse(
          response['message']['message']);
      resolve(response['message']);
    }
  } else {
    if (reject) {
      reject(new Error(result));
    }
  }
};


/**
 * Send a single RPC to the server.
 *
 * See sendRPCs_()
 *
 * @param {string} command Command name to call
 * @param {Object} args Arguments to pass to server
 * @param {?function(Object)=} opt_onSuccess Success callback function
 * @private
 */
Cosmopolite.prototype.sendRPC_ = function(command, args, opt_onSuccess) {
  /** @type {Cosmopolite.typeRPC_} */
  var rpc = {
    'command': command,
    'arguments': args,
    'onSuccess': opt_onSuccess || null
  };
  this.sendRPCs_([rpc]);
};


/**
 * Callback for XHR load.
 *
 * @param {XMLHttpRequest} xhr
 * @param {function(Array.<Cosmopolite.typeRPC_>)} retryAfterDelay
 * @param {Array.<Cosmopolite.typeRPC_>} commands
 * @private
 */
Cosmopolite.prototype.onRPCResponse_ =
    function(xhr, retryAfterDelay, commands) {
  if (xhr.status != 200) {
    retryAfterDelay(commands);
    return;
  }
  var data = xhr.response;

  if ('google_user_id' in data) {
    localStorage[this.namespace_ + ':google_user_id'] =
        data['google_user_id'];
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

  /** @type {string} */
  this.profile_ = data['profile'];
  this.trackEvent('set', 'userId', this.profile_);
  var resolve;
  while (resolve = this.profilePromises_.pop()) {
    resolve(this.profile_);
  }

  for (var i = 0; i < data['responses'].length; i++) {
    var response = data['responses'][i];
    if (response['result'] == 'retry') {
      continue;
    }
    if (commands[i]['preEvents']) {
      commands[i]['preEvents'].bind(this)(data['responses'][i]);
    }
  }

  // Handle events that were immediately available as if they came over the
  // channel. Fire them before the message events, so clients can use
  // events like the subscribe promise fulfillment as a barrier for initial
  // data.
  data['events'].forEach(this.onServerEvent_, this);

  /** @type {Array.<Cosmopolite.typeRPC_>} */
  var retryCommands = [];

  for (var i = 0; i < data['responses'].length; i++) {
    var response = data['responses'][i];
    if (response['result'] == 'retry') {
      retryCommands.push(commands[i]);
      continue;
    }
    if (commands[i]['onSuccess']) {
      commands[i]['onSuccess'].bind(this)(data['responses'][i]);
    }
  }

  if (retryCommands.length) {
    retryAfterDelay(retryCommands);
  }
};


/**
 * Send one or more RPCs to the server.
 *
 * Wraps handling of authentication to the server, even in cases where we need
 * to retry with more data. Also retries in cases of failure with exponential
 * backoff.
 *
 * @param {Array.<Cosmopolite.typeRPC_>} commands List of commands to execute
 * @param {number=} opt_delay Milliseconds waited before executing this call for
 *     backoff
 * @private
 */
Cosmopolite.prototype.sendRPCs_ = function(commands, opt_delay) {
  if (this.shutdown_ || !commands.length) {
    return;
  }
  var request = {
    'instance_id': this.instanceID_,
    'client_id': this.clientID_,
    'commands': []
  };
  commands.forEach(function(command) {
    var request_command = {
      'command': command['command']
    };
    if ('arguments' in command) {
      request_command['arguments'] = command['arguments'];
    }
    request.commands.push(request_command);
  });
  if (this.namespace_ + ':google_user_id' in localStorage) {
    request['google_user_id'] =
        localStorage[this.namespace_ + ':google_user_id'];
  }

  var xhr = new XMLHttpRequest();

  var retryAfterDelay = (function(newCommands) {
    // Exponential backoff + random stagger values
    var min_ms = 250;
    var max_ms = 32000;
    var exponent = 1.1;
    var stagger_factor = 0.1;

    var intDelay =
        xhr.getResponseHeader('Retry-After') ||
        Math.min(max_ms, Math.max(min_ms, opt_delay || min_ms));
    intDelay += intDelay * stagger_factor * Math.random();
    intDelay = Math.ceil(intDelay);
    console.log(
        this.loggingPrefix_(),
        'RPC failed; will retry in ' + intDelay + 'ms');
    var retry = (function() {
      var newDelay = Math.ceil(Math.pow(intDelay, exponent));
      this.sendRPCs_(newCommands, newDelay);
    }).bind(this);
    window.setTimeout(retry, intDelay);
  }).bind(this);

  xhr.addEventListener(
      'load', this.onRPCResponse_.bind(this, xhr, retryAfterDelay, commands));
  xhr.addEventListener('error', retryAfterDelay.bind(null, commands));
  xhr.open('POST', this.urlPrefix_ + '/api');
  xhr.setRequestHeader('Content-Type', 'application/json');
  xhr.responseType = 'json';
  xhr.send(JSON.stringify(request));
};


/**
 * Handle tasks needed after reconnecting the channel
 *
 * @private
 */
Cosmopolite.prototype.onReconnect_ = function() {
  /** @type {Array.<Cosmopolite.typeRPC_>} */
  var rpcs = [];
  for (var subject in this.subscriptions_) {
    /** @type {Cosmopolite.typeSubscription_} */
    var subscription = this.subscriptions_[subject];
    if (subscription.state != Cosmopolite.SubscriptionState_.ACTIVE) {
      continue;
    }
    if (subject['local']) {
      continue;
    }
    /** @type {number} */
    var lastID = 0;
    if (subscription.messages.length > 0) {
      lastID = subscription.messages[subscription.messages.length - 1]['id'];
    }
    rpcs.push({
      'command': 'subscribe',
      'arguments': {
        'subject': subscription['subject'],
        'last_id': lastID
      }
    });
  }
  for (var id in this.pins_) {
    /** @type {Cosmopolite.typeMessage} */
    var pin = this.pins_[id];
    if (pin.subject['local']) {
      continue;
    }
    rpcs.push({
      'command': 'pin',
      'arguments': pin
    });
  }
  this.sendRPCs_(rpcs);
};


/**
 * Send RPC to create a server -> client channel
 *
 * @private
 */
Cosmopolite.prototype.createChannel_ = function() {
  if (this.channelState_ == Cosmopolite.ChannelState_.CLOSED) {
    this.channelState_ = Cosmopolite.ChannelState_.PENDING;
  } else {
    return;
  }

  var rpcs = [
    {
      'command': 'createChannel',
      'onSuccess': this.onCreateChannel_
    }
  ];
  this.sendRPCs_(rpcs);
};


/**
 * Callback for channel creation on the server side
 *
 * @suppress {missingProperties}
 *
 * @param {Object} data
 * @private
 */
Cosmopolite.prototype.onCreateChannel_ = function(data) {
  if (this.shutdown_) {
    return;
  }

  if (this.channelState_ == Cosmopolite.ChannelState_.PENDING) {
    this.channelState_ = Cosmopolite.ChannelState_.OPENING;
  } else {
    return;
  }

  this.channelAPIPromise_.then(function() {
    var channel = new goog.appengine.Channel(data['token']);
    console.log(this.loggingPrefix_(), 'opening channel:', data['token']);
    this.socket_ = channel.open({
      onopen: this.onSocketOpen_.bind(this),
      onclose: this.onSocketClose_.bind(this),
      onmessage: this.onSocketMessage_.bind(this),
      onerror: this.onSocketError_.bind(this)
    });
  }.bind(this));
};


/**
 * Callback from channel library for successful open
 *
 * @private
 */
Cosmopolite.prototype.onSocketOpen_ = function() {
  console.log(this.loggingPrefix_(), 'channel opened');

  if (this.shutdown_ && this.socket_) {
    this.socket_.close();
  }

  if (this.channelState_ == Cosmopolite.ChannelState_.OPENING) {
    this.channelState_ = Cosmopolite.ChannelState_.OPEN;
    this.onConnect_();
  } else {
    return;
  }

  this.onReconnect_();
};


/**
 * Callback from channel library for closure; reopen.
 *
 * @private
 */
Cosmopolite.prototype.onSocketClose_ = function() {
  console.log(this.loggingPrefix_(), 'channel closed');

  if (this.shutdown_) {
    return;
  }

  if (this.channelState_ == Cosmopolite.ChannelState_.OPEN) {
    this.channelState_ = Cosmopolite.ChannelState_.CLOSED;
    this.onDisconnect_();
  } else {
    return;
  }

  // We treat a disconnection as if all pins disappeared
  for (var subject in this.subscriptions_) {
    var subscription = this.subscriptions_[subject];
    subscription.pins.forEach(function(pin) {
      // Stupid hack that saves complexity elsewhere
      pin['message'] = JSON.stringify(pin['message']);
      this.onUnpin_(pin);
    }, this);
  }

  this.instanceID_ = this.uuid();

  this.createChannel_();
};


/**
 * Callback from channel library for message reception over channel
 *
 * @param {{data: string}} msg
 * @private
 */
Cosmopolite.prototype.onSocketMessage_ = function(msg) {
  this.onServerEvent_(
      /** @type {Cosmopolite.typeEvent_} */ (JSON.parse(msg.data)));
};


/**
 * Callback from channel library for error on channel
 *
 * @param {{description: string, code: number}} msg
 * @private
 */
Cosmopolite.prototype.onSocketError_ = function(msg) {
  console.log(this.loggingPrefix_(), 'socket error:', msg);
  if (this.socket_) {
    this.socket_.close();
  }
};


/**
 * Callback on receiving a 'close' event from the server
 *
 * @private
 */
Cosmopolite.prototype.onClose_ = function() {
  console.log(this.loggingPrefix_(), 'server asked us to close our socket');
  if (this.socket_) {
    this.socket_.close();
  }
};


/**
 * Callback on connection to server
 *
 * @private
 */
Cosmopolite.prototype.onConnect_ = function() {
  var e = new CustomEvent('connect', {
    'detail': {
    }
  });
  this.dispatchEvent(e);
};


/**
 * Callback on disconnection from server
 *
 * @private
 */
Cosmopolite.prototype.onDisconnect_ = function() {
  var e = new CustomEvent('disconnect', {
    'detail': {
    }
  });
  this.dispatchEvent(e);
};


/**
 * Callback on receiving a 'login' event from the server
 *
 * @param {Cosmopolite.typeLogin_} e
 * @private
 */
Cosmopolite.prototype.onLogin_ = function(e) {
  var e2 = new CustomEvent('login', {
    'detail': {
      'username': e['google_user'],
      'logout_url': this.urlPrefix_ + '/auth/logout'
    }
  });
  this.dispatchEvent(e2);
};


/**
 * Callback on receiving a 'logout' event from the server
 *
 * @param {Cosmopolite.typeLogout_} e
 * @private
 */
Cosmopolite.prototype.onLogout_ = function(e) {
  var e2 = new CustomEvent('logout', {
    'detail': {
      'login_url': this.urlPrefix_ + '/auth/login'
    }
  });
  this.dispatchEvent(e2);
};


/**
 * Callback on receiving a 'message' event from the server
 *
 * @param {Cosmopolite.typeMessage} e
 * @private
 */
Cosmopolite.prototype.onMessage_ = function(e) {
  /** @type {string} */
  var subjectString = this.subjectString_(e['subject']);
  /** @type {Cosmopolite.typeSubscription_} */
  var subscription = this.subscriptions_[subjectString];
  if (!subscription) {
    console.log(
        this.loggingPrefix_(),
        'message from unrecognized subject:', e);
    console.log(
        this.loggingPrefix_(),
        'subscriptions:', this.subscriptions_);
    return;
  }
  /** @type {boolean} */
  var duplicate = subscription.messages.some(function(message) {
    return message['id'] == e.id;
  });
  if (duplicate) {
    return;
  }
  e['message'] = JSON.parse(e['message']);

  // Reverse search for the position to insert this message, as it will most
  // likely be at the end.
  /** @type {?number} */
  var insertAfter;
  for (var insertAfter = subscription.messages.length - 1;
       insertAfter >= 0; insertAfter--) {
    var message = subscription.messages[insertAfter];
    if (message['id'] < e['id']) {
      break;
    }
  }
  subscription.messages.splice(insertAfter + 1, 0, e);

  this.writeMessageCache_(e['subject']);

  var e2 = new CustomEvent('message', {
    'detail': e
  });
  this.dispatchEvent(e2);
};


/**
 * Callback on receiving a 'pin' event from the server
 *
 * @param {Cosmopolite.typeMessage} e
 * @private
 */
Cosmopolite.prototype.onPin_ = function(e) {
  /** @type {string} */
  var subjectString = this.subjectString_(e['subject']);
  /** @type {Cosmopolite.typeSubscription_} */
  var subscription = this.subscriptions_[subjectString];
  if (!subscription) {
    console.log(
        this.loggingPrefix_(),
        'message from unrecognized subject:', e);
    return;
  }
  /** @type {boolean} */
  var duplicate = subscription.pins.some(function(pin) {
    return pin['id'] == e.id;
  });
  if (duplicate) {
    console.log(this.loggingPrefix_(), 'duplicate pin:', e);
    return;
  }
  e['message'] = JSON.parse(e['message']);

  subscription.pins.push(e);

  var e2 = new CustomEvent('pin', {
    'detail': e
  });
  this.dispatchEvent(e2);
};


/**
 * Callback on receiving an 'unpin' event from the server
 *
 * @param {Cosmopolite.typeMessage} e
 * @private
 */
Cosmopolite.prototype.onUnpin_ = function(e) {
  /** @type {string} */
  var subjectString = this.subjectString_(e['subject']);
  /** @type {Cosmopolite.typeSubscription_} */
  var subscription = this.subscriptions_[subjectString];
  if (!subscription) {
    console.log(
        this.loggingPrefix_(),
        'message from unrecognized subject:', e);
    return;
  }
  /** @type {?number} */
  var index;
  for (index = 0; index < subscription.pins.length; index++) {
    var pin = subscription.pins[index];
    if (pin['id'] == e['id']) {
      break;
    }
  }
  if (index == subscription.pins.length) {
    console.log(this.loggingPrefix_(), 'unknown pin:', e);
    return;
  }
  e['message'] = JSON.parse(e['message']);

  subscription.pins.splice(index, 1);

  var e2 = new CustomEvent('unpin', {
    'detail': e
  });
  this.dispatchEvent(e2);
};


/**
 * Callback for Cosmopolite event (received via channel or pseudo-channel)
 *
 * @param {Cosmopolite.typeEvent_} e
 * @private
 */
Cosmopolite.prototype.onServerEvent_ = function(e) {
  if (this.shutdown_) {
    return;
  }
  switch (e['event_type']) {
    case 'close':
      this.onClose_();
      break;
    case 'login':
      this.onLogin_(/** @type {Cosmopolite.typeLogin_} */ (e));
      break;
    case 'logout':
      this.onLogout_(/** @type {Cosmopolite.typeLogout_} */ (e));
      break;
    case 'message':
      this.onMessage_(/** @type {Cosmopolite.typeMessage} */ (e));
      break;
    case 'pin':
      this.onPin_(/** @type {Cosmopolite.typeMessage} */ (e));
      break;
    case 'unpin':
      this.onUnpin_(/** @type {Cosmopolite.typeMessage } */ (e));
      break;
    default:
      // Client out of date? Force refresh?
      console.log(this.loggingPrefix_(), 'unknown channel event:', e);
      break;
  }
};


/** @type {function(new:Cosmopolite,
                    ?string=,
                    ?string=)} */
window.Cosmopolite = Cosmopolite;
