var nconf = require('nconf');
var ldap  = require('ldapjs');
var exit  = require('./exit');
var client, binder;
var crypto = require('./crypto');
var cb = require('cb');
var https = require('https');

// decrypt only once
let ldapBindCredentials;

// heartbeat related consts
const HEARTHBEAT_QUERY_TIMEOUT_MS = 5000;
const HEARTBEAT_DELAY_MS = nconf.get('LDAP_HEARTBEAT_SECONDS') * 1000

function createConnection () {
  var clientOpts = {
    url: nconf.get("LDAP_URL")
  };

  if (nconf.get('LDAP_URL').toLowerCase().substr(0, 5) === 'ldaps') {
    clientOpts.tlsOptions = { ca: https.globalAgent.options.ca };
  }

  return ldap.createClient(clientOpts);
}

function initializeConnection () {
  var connection = createConnection();

  connection.on('close', function () {
    console.error('Connection to ldap was closed.');
    exit(1);
  });

  connection.heartbeat = function (callback) {
    // alway re-bind the connection in an heartbeat before searching, underlying connection might be bound to a different users from previous
    // login validations, and the search query might fail randomly otherwise.
    const user = nconf.get('ANONYMOUS_SEARCH_ENABLED') ? '' : nconf.get("LDAP_BIND_USER");
    const creds = nconf.get('ANONYMOUS_SEARCH_ENABLED') ? '' : ldapBindCredentials;
    
    connection.bind(user, creds, function(err) {
      if(err){
        console.error("Heartbeat: Error binding to LDAP", 'dn: ' + err.dn + '\n code: ' + err.code + '\n message: ' + err.message);
        return callback(err);
      }
      
      connection.search(nconf.get('LDAP_BASE'), nconf.get('LDAP_HEARTBEAT_SEARCH_QUERY'), function (err, res) {
        if (err) {
          return callback(err);
        }
  
        var abort = setTimeout(function () {
          client.removeAllListeners('end');
          client.removeAllListeners('error');
          callback(new Error(`No heartbeat response within allocated timeout of ${HEARTHBEAT_QUERY_TIMEOUT_MS} ms`));
        }, HEARTHBEAT_QUERY_TIMEOUT_MS);
  
        res.once('error', function(err) {
          client.removeAllListeners('end');
          clearTimeout(abort);
          callback(err);
        }).once('end', function () {
          client.removeAllListeners('error');
          clearTimeout(abort);
          callback();
        });
      });
    });
  };

  function protect_with_timeout (func) {
    var original = connection[func];
    connection[func] = function () {
      var args = [].slice.call(arguments);
      var original_callback = args.pop();
      var timeoutable_callback = cb(original_callback).timeout(450000);
      var new_args = args.concat([timeoutable_callback]);
      return original.apply(this, new_args);
    };
  }
  protect_with_timeout('bind');
  protect_with_timeout('search');

  function ping_recurse () {
    connection.heartbeat(function (err) {
      if (err) {
        console.error('Error on heartbeat response from LDAP: ', err.message);
        return exit(1);
      }
      setTimeout(ping_recurse, HEARTBEAT_DELAY_MS);
    });
  }

  if (!nconf.get('ANONYMOUS_SEARCH_ENABLED')) {
    if(!ldapBindCredentials) {
      ldapBindCredentials = nconf.get('LDAP_BIND_PASSWORD') || crypto.decrypt(nconf.get('LDAP_BIND_CREDENTIALS'));
    }
    
    connection.bind(nconf.get("LDAP_BIND_USER"), ldapBindCredentials, function(err) {
      if(err){
        console.error("Error binding to LDAP", 'dn: ' + err.dn + '\n code: ' + err.code + '\n message: ' + err.message);
        return exit(1);
      }
      ping_recurse();
    });
  } else {
    ping_recurse();
  }

  return connection;
}

module.exports.createConnection = createConnection;

Object.defineProperty(module.exports, 'client', {
  enumerable: true,
  configurable: false,
  get: function () {
    client = client || initializeConnection();
    return client;
  }
});

Object.defineProperty(module.exports, 'binder', {
  enumerable: true,
  configurable: false,
  get: function () {
    binder = binder || initializeConnection();
    return binder;
  }
});
