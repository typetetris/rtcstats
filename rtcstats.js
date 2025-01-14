'use strict';

// transforms a maplike to an object. Mostly for getStats +
// JSON.parse(JSON.stringify())
function map2obj(m) {
  if (!m.entries) {
    return m;
  }
  var o = {};
  m.forEach(function(v, k) {
    o[k] = v;
  });
  return o;
}

// apply a delta compression to the stats report. Reduces size by ~90%.
// To reduce further, report keys could be compressed.
function deltaCompression(oldReportList, newReportList) {
  newReportList = JSON.parse(JSON.stringify(newReportList));

  // Determine timestamp for the report list
  const timestamp = Math.max.apply(null, Object.values(newReportList).map(function (it) { return it.timestamp;}));

  // Insert tombstones for vanished reports
  Object.keys(oldReportList).forEach(function(subjectId) {
    if (!newReportList[subjectId]) {
      newReportList[subjectId] = {
        tombstone: "tombstone"
      };
    }
  });

  // Remove unchanged statistics
  Object.keys(newReportList).forEach(function(subjectId) {
    var report = newReportList[subjectId];
    delete report.id;

    // Report is new, don't delete anything.
    if (!oldReportList[subjectId]) {
      return;
    }

    Object.keys(report).forEach(function(statisticName) {
      if (statisticName === "timestamp") {
        return;
      }
      // Statistic is unchanged => delete
      if (report[statisticName] === oldReportList[subjectId][statisticName]) {
        delete newReportList[subjectId][statisticName];
      }
    });

    // Delete timestamps equal to global report list timestamp
    if (report.timestamp === timestamp && oldReportList[subjectId]["timestamp"]) {
      delete report.timestamp;
    }

    // Delete empty report changes
    if (Object.keys(report).length === 0) {
        // Report has become empty => delete entire report
        delete newReportList[subjectId];
    }
  });

  // Set global report list timestamp
  newReportList.timestamp = timestamp;
  return newReportList;
}

function dumpTrack(track) {
  return {
    id: track.id,                 // unique identifier (GUID) for the track
    kind: track.kind,             // `audio` or `video`
    label: track.label,           // identified the track source
    enabled: track.enabled,       // application can control it
    muted: track.muted,           // application cannot control it (read-only)
    readyState: track.readyState, // `live` or `ended`
  }
}

function dumpStream(stream) {
  return {
    id: stream.id,
    tracks: stream.getTracks().map(function(track) {
      return dumpTrack(track);
    }),
  };
}

function dumpTransceiverInit(transceiverInit) {
  if (transceiverInit === null) {
    return null;
  } else if (typeof transceiverInit === 'object') {
    return {
      direction: transceiverInit.direction,
      streams: transceiverInit.streams?.map(function (stream) { return dumpStream(stream); }),
      sendEncodings: transceiverInit.sendEncodings
    };
  } else {
    return 'unknown/type error';
  }
}

/*
function filterBoringStats(results) {
  Object.keys(results).forEach(function(id) {
    switch (results[id].type) {
      case 'certificate':
      case 'codec':
        delete results[id];
        break;
      default:
        // noop
    }
  });
  return results;
}

function removeTimestamps(results) {
  // FIXME: does not work in FF since the timestamp can't be deleted.
  Object.keys(results).forEach(function(id) {
    delete results[id].timestamp;
  });
  return results;
}
*/

module.exports = function(trace, getStatsInterval, prefixesToWrap) {
  var peerconnectioncounter = 0;
  var isFirefox = !!window.mozRTCPeerConnection;
  var isEdge = !!window.RTCIceGatherer;
  prefixesToWrap.forEach(function(prefix) {
    if (!window[prefix + 'RTCPeerConnection']) {
      return;
    }
    if (prefix === 'webkit' && isEdge) {
      // dont wrap webkitRTCPeerconnection in Edge.
      return;
    }
    var origPeerConnection = window[prefix + 'RTCPeerConnection'];
    var peerconnection = function(config, constraints) {
      var pc = new origPeerConnection(config, constraints);
      var id = 'PC_' + peerconnectioncounter++;
      pc.__rtcStatsId = id;

      if (!config) {
        config = { nullConfig: true };
      }

      config = JSON.parse(JSON.stringify(config)); // deepcopy
      // don't log credentials
      ((config && config.iceServers) || []).forEach(function(server) {
        delete server.credential;
      });

      if (isFirefox) {
        config.browserType = 'moz';
      } else if (isEdge) {
        config.browserType = 'edge';
      } else {
        config.browserType = 'webkit';
      }

      trace('create', id, config);
      // TODO: do we want to log constraints here? They are chrome-proprietary.
      // http://stackoverflow.com/questions/31003928/what-do-each-of-these-experimental-goog-rtcpeerconnectionconstraints-do
      if (constraints) {
        trace('constraints', id, constraints);
      }

      pc.addEventListener('icecandidate', function(e) {
        trace('onicecandidate', id, e.candidate);
      });
      pc.addEventListener('addstream', function(e) {
        trace('onaddstream', id, e.stream.id + ' ' + e.stream.getTracks().map(function(t) { return t.kind + ':' + t.id; }));
      });
      pc.addEventListener('track', function(e) {
        trace('ontrack', id, e.track.kind + ':' + e.track.id + ' ' + e.streams.map(function(stream) { return 'stream:' + stream.id; }));
      });
      pc.addEventListener('removestream', function(e) {
        trace('onremovestream', id, e.stream.id + ' ' + e.stream.getTracks().map(function(t) { return t.kind + ':' + t.id; }));
      });
      pc.addEventListener('signalingstatechange', function() {
        trace('onsignalingstatechange', id, pc.signalingState);
      });
      pc.addEventListener('iceconnectionstatechange', function() {
        trace('oniceconnectionstatechange', id, pc.iceConnectionState);
      });
      pc.addEventListener('icegatheringstatechange', function() {
        trace('onicegatheringstatechange', id, pc.iceGatheringState);
      });
      pc.addEventListener('connectionstatechange', function() {
        trace('onconnectionstatechange', id, pc.connectionState);
      });
      pc.addEventListener('negotiationneeded', function() {
        trace('onnegotiationneeded', id, undefined);
      });
      pc.addEventListener('datachannel', function(event) {
        trace('ondatachannel', id, [event.channel.id, event.channel.label]);
      });

      var prev = {};
      var getStats = function() {
        pc.getStats(null).then(function(res) {
          var now = map2obj(res);
          // trace('getstatsRaw', id, JSON.parse(JSON.stringify(now)));
          var base = JSON.parse(JSON.stringify(now)); // our new prev
          trace('getstats', id, deltaCompression(prev, now));
          prev = base;
        });
      };

      var getSendersInfos = function() {
        var sendersInfos = pc.getSenders().map(function (sender) {
          var track;
          if (sender.track) {
            track = dumpTrack(sender.track);
          }
          return {
            track: track,
            parameters: sender.getParameters()
          };
        });
        trace('sendersInfos', id, sendersInfos);
      };

      // TODO: do we want one big interval and all peerconnections
      //    queried in that or one setInterval per PC?
      //    we have to collect results anyway so...
      if (!isEdge && getStatsInterval) {
        var getStatsIntervalObject = window.setInterval(function() {
          if (pc.signalingState === 'closed') {
            window.clearInterval(getStatsIntervalObject);
            return;
          }
          getStats();
        }, getStatsInterval);
      }

      // TODO: make interval configurable
      if (!isEdge) {
        var sendersInfosIntervalObject = window.setInterval(function () {
          if (pc.signalingState === 'closed') {
            window.clearInterval(sendersInfosIntervalObject);
            return;
          }
          getSendersInfos();
        }, 30 * 1000);
      }

      if (!isEdge) {
        pc.addEventListener('connectionstatechange', function() {
          if (pc.connectionState === 'connected' || pc.connectionState === 'failed') {
            getStats();
          }
        });
      }

      return pc;
    };

    ['createDataChannel', 'close'].forEach(function(method) {
      var nativeMethod = origPeerConnection.prototype[method];
      if (nativeMethod) {
        origPeerConnection.prototype[method] = function() {
          trace(method, this.__rtcStatsId, arguments);
          return nativeMethod.apply(this, arguments);
        };
      }
    });

    ['addStream', 'removeStream'].forEach(function(method) {
      var nativeMethod = origPeerConnection.prototype[method];
      if (nativeMethod) {
        origPeerConnection.prototype[method] = function() {
          var stream = arguments[0];
          var streamInfo = stream.getTracks().map(function(t) {
            return t.kind + ':' + t.id;
          }).join(',');

          trace(method, this.__rtcStatsId, stream.id + ' ' + streamInfo);
          return nativeMethod.apply(this, arguments);
        };
      }
    });

    ['addTrack'].forEach(function(method) {
      var nativeMethod = origPeerConnection.prototype[method];
      if (nativeMethod) {
        origPeerConnection.prototype[method] = function() {
          var track = arguments[0];
          var streams = [].slice.call(arguments, 1);
          trace(method, this.__rtcStatsId, track.kind + ':' + track.id + ' ' + (streams.map(function(s) { return 'stream:' + s.id; }).join(';') || '-'));
          return nativeMethod.apply(this, arguments);
        };
      }
    });

    ['addTransceiver'].forEach(function(method) {
      var nativeMethod = origPeerConnection.prototype[method];
      if (nativeMethod) {
        origPeerConnection.prototype[method] = function() {
          var trackOrKind = arguments[0];
          var track;
          var kind;
          if (typeof trackOrKind === 'string') {
            kind = trackOrKind;
          } else {
            track = dumpTrack(trackOrKind);
          }
          var transceiverInit;
          if (arguments.length === 2) {
            transceiverInit = dumpTransceiverInit(arguments[1]);
          }

          trace(method, this.__rtcStatsId, { kind: kind, track: track, transceiverInit: transceiverInit });

          return nativeMethod.apply(this, arguments);
        };
      }
    });

    ['removeTrack'].forEach(function(method) {
      var nativeMethod = origPeerConnection.prototype[method];
      if (nativeMethod) {
        origPeerConnection.prototype[method] = function() {
          var track = arguments[0].track;
          trace(method, this.__rtcStatsId, track ? track.kind + ':' + track.id : 'null');
          return nativeMethod.apply(this, arguments);
        };
      }
    });

    ['createOffer', 'createAnswer'].forEach(function(method) {
      var nativeMethod = origPeerConnection.prototype[method];
      if (nativeMethod) {
        origPeerConnection.prototype[method] = function() {
          var rtcStatsId = this.__rtcStatsId;
          var args = arguments;
          var opts;
          if (arguments.length === 1 && typeof arguments[0] === 'object') {
            opts = arguments[0];
          } else if (arguments.length === 3 && typeof arguments[2] === 'object') {
            opts = arguments[2];
          }
          trace(method, this.__rtcStatsId, opts);
          return nativeMethod.apply(this, opts ? [opts] : undefined)
          .then(function(description) {
            trace(method + 'OnSuccess', rtcStatsId, description);
            if (args.length > 0 && typeof args[0] === 'function') {
              args[0].apply(null, [description]);
              return undefined;
            }
            return description;
          }, function(err) {
            trace(method + 'OnFailure', rtcStatsId, err.toString());
            if (args.length > 1 && typeof args[1] === 'function') {
              args[1].apply(null, [err]);
              return;
            }
            throw err;
          });
        };
      }
    });

    ['setLocalDescription', 'setRemoteDescription', 'addIceCandidate'].forEach(function(method) {
      var nativeMethod = origPeerConnection.prototype[method];
      if (nativeMethod) {
        origPeerConnection.prototype[method] = function() {
          var rtcStatsId = this.__rtcStatsId;
          var args = arguments;
          trace(method, this.__rtcStatsId, args[0]);
          return nativeMethod.apply(this, [args[0]])
          .then(function() {
            trace(method + 'OnSuccess', rtcStatsId, undefined);
            if (args.length >= 2 && typeof args[1] === 'function') {
              args[1].apply(null, []);
              return undefined;
            }
            return undefined;
          }, function(err) {
            trace(method + 'OnFailure', rtcStatsId, err.toString());
            if (args.length >= 3 && typeof args[2] === 'function') {
              args[2].apply(null, [err]);
              return undefined;
            }
            throw err;
          });
        };
      }
    });

    // wrap static methods. Currently just generateCertificate.
    if (origPeerConnection.generateCertificate) {
      Object.defineProperty(peerconnection, 'generateCertificate', {
        get: function() {
          return arguments.length ?
              origPeerConnection.generateCertificate.apply(null, arguments)
              : origPeerConnection.generateCertificate;
        },
      });
    }
    window[prefix + 'RTCPeerConnection'] = peerconnection;
    window[prefix + 'RTCPeerConnection'].prototype = origPeerConnection.prototype;
  });

  // getUserMedia wrappers
  prefixesToWrap.forEach(function(prefix) {
    var name = prefix + (prefix.length ? 'GetUserMedia' : 'getUserMedia');
    if (!navigator[name]) {
      return;
    }
    var origGetUserMedia = navigator[name].bind(navigator);
    var gum = function() {
      trace('getUserMedia', null, arguments[0]);
      var cb = arguments[1];
      var eb = arguments[2];
      origGetUserMedia(arguments[0],
        function(stream) {
          // we log the stream id, track ids and tracks readystate since that is ended GUM fails
          // to acquire the cam (in chrome)
          trace('getUserMediaOnSuccess', null, dumpStream(stream));
          if (cb) {
            cb(stream);
          }
        },
        function(err) {
          trace('getUserMediaOnFailure', null, err.name);
          if (eb) {
            eb(err);
          }
        }
      );
    };
    navigator[name] = gum.bind(navigator);
  });

  if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
    var origGetUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    var gum = function() {
      trace('navigator.mediaDevices.getUserMedia', null, arguments[0]);
      return origGetUserMedia.apply(navigator.mediaDevices, arguments)
      .then(function(stream) {
        trace('navigator.mediaDevices.getUserMediaOnSuccess', null, dumpStream(stream));
        return stream;
      }, function(err) {
        trace('navigator.mediaDevices.getUserMediaOnFailure', null, err.name);
        return Promise.reject(err);
      });
    };
    navigator.mediaDevices.getUserMedia = gum.bind(navigator.mediaDevices);
  }

  // getDisplayMedia
  if (navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia) {
    var origGetDisplayMedia = navigator.mediaDevices.getDisplayMedia.bind(navigator.mediaDevices);
    var gdm = function() {
      trace('navigator.mediaDevices.getDisplayMedia', null, arguments[0]);
      return origGetDisplayMedia.apply(navigator.mediaDevices, arguments)
      .then(function(stream) {
        trace('navigator.mediaDevices.getDisplayMediaOnSuccess', null, dumpStream(stream));
        return stream;
      }, function(err) {
        trace('navigator.mediaDevices.getDisplayMediaOnFailure', null, err.name);
        return Promise.reject(err);
      });
    };
    navigator.mediaDevices.getDisplayMedia = gdm.bind(navigator.mediaDevices);
  }

  // TODO: are there events defined on MST that would allow us to listen when enabled was set?
  //    no :-(
  /*
  Object.defineProperty(MediaStreamTrack.prototype, 'enabled', {
    set: function(value) {
      trace('MediaStreamTrackEnable', this, value);
    }
  });
  */
};
