const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const crypto = require('crypto');
const dotenv = require('dotenv')
const fs = require('fs');
const setup = require("./setup.js");
setTimeout(async () => {
  try {

    const didSetup = await setup();

    if (didSetup) {
      process.exit()
    } else {
      startServer();
    }

  } catch (err) {
    console.error("Setup failed:", err);
    process.exit(1);
  }
}, 600);
dotenv.config({ quiet: true });
const app = express();
const server = http.createServer(app);
const io = socketIo(server);

const bannedHomes = new Set();
const authorizedHomes = new Set();

function loadAuthorizedHomes() {
  const filePath = path.join(__dirname, 'authorized_homes.json'); // [home, home2]
  if (fs.existsSync(filePath)) {
    try {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      if (Array.isArray(data)) {
        data.forEach(home => authorizedHomes.add(home));
        console.log(`Loaded ${authorizedHomes.size} authorized homes from file.`);
      } else {
        console.warn('authorized_homes.json is not an array. Starting with empty authorized homes.');
      }
    } catch (error) {
      console.error('Error reading authorized_homes.json:', error);
    }
  }
}
function loadBannedHomes() {
  const filePath = path.join(__dirname, 'banned_homes.json'); // [home, home2]
  if (fs.existsSync(filePath)) {
    try {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      if (Array.isArray(data)) {
        data.forEach(home => bannedHomes.add(home));
        console.log(`Loaded ${bannedHomes.size} banned homes from file.`);
      } else {
        console.warn('banned_homes.json is not an array. Starting with empty banned homes.');
      }
    } catch (error) {
      console.error('Error reading banned_homes.json:', error);
    }
  }
}

loadBannedHomes();
loadAuthorizedHomes();

const PORT = process.env.PORT
const token = process.env.token
app.use(express.static(path.join(__dirname, 'frontend')));
app.use('/socket.io', express.static(path.join(__dirname, 'node_modules/socket.io/client-dist')));

const MAX_HISTORY = 200;
const MAX_MSG_LENGTH = 1000;
const NICK_MAX_LENGTH = 30;
const RATE_WINDOW_MS = 10000;
const RATE_MAX_MSGS = 12;
const MIN_INTER_MSG_MS = 100;

const HOME_SALT = process.env.HOME_SALT

let users = [];
let messages = [];
const connMap = new Map();
function sanitizeHTML(str) {
  if (typeof str !== 'string') return '';
  str = str.replace(/[\x00-\x1F\x7F]/g, '');
  return str.replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}


function sanitizeStyle(style) {
  if (!style || typeof style !== 'string') return '';
  const allowed = {
    'bold': 'font-weight:bold;',
    'italic': 'font-style:italic;',
    'underline': 'text-decoration:underline;',
    'small': 'font-size:0.9em;',
    'large': 'font-size:1.1em;'
  };
  return style.split(/[,\s]+/)
    .map(s => allowed[s.toLowerCase()])
    .filter(Boolean)
    .join('');
}
function sanitizeColor(color) {
  if (typeof color !== 'string') return '#ffffff';
  color = color.trim().toLowerCase();


  if (/^#([0-9a-f]{3}|[0-9a-f]{6})$/.test(color)) return color;


  if (/^[a-z]+$/.test(color)) return color;

  return '#ffffff';
}
function allowMessage(socket) {
  const now = Date.now();
  if (!socket.msgTimestamps) socket.msgTimestamps = [];
  if (!socket.lastMsgTime) socket.lastMsgTime = 0;
  if (now - socket.lastMsgTime < MIN_INTER_MSG_MS) return false;
  socket.msgTimestamps = socket.msgTimestamps.filter(ts => now - ts <= RATE_WINDOW_MS);
  if (socket.msgTimestamps.length >= RATE_MAX_MSGS) return false;
  socket.msgTimestamps.push(now);
  socket.lastMsgTime = now;
  return true;
}

function checkHash(str, hash) {
  const strHash = crypto.createHash('sha256').update(HOME_SALT + '|' + str).digest('hex');
  return strHash === hash;
}

function commitBannedHomes() {
  const filePath = path.join(__dirname, 'banned_homes.json');
  fs.writeFileSync(filePath, JSON.stringify(Array.from(bannedHomes)), 'utf-8');
}

function commitAuthorizedHomes() {
  const filePath = path.join(__dirname, 'authorized_homes.json');
  fs.writeFileSync(filePath, JSON.stringify(Array.from(authorizedHomes)), 'utf-8');
}

class System {
  constructor() {
    this.nick = '~';
    this.color = '#00ff00';
    this.home = 'system';
  }
  log(msg, sanitize = false) {
    const messageData = {
      date: Date.now(),
      nick: this.nick,
      color: this.color,
      home: this.home,
      isSystem: true,
      msg: sanitize ? sanitizeHTML(msg) : msg
    };
    io.emit('message', messageData);
  }
  sendLogToClient(client, msg, sanitize = false) {
    const messageData = {
      date: Date.now(),
      nick: this.nick,
      color: this.color,
      home: this.home,
      isSystem: true,
      msg: sanitize ? sanitizeHTML(msg) : msg
    };
    client.emit('message', messageData);
  }
}
const sys = new System();

function computeHomeFromIP(ip) {
  return crypto.createHash('sha256').update(HOME_SALT + '|' + ip).digest('hex');
}

function banHome(homeHash, reason = 'banned by moderator') {

  for (const [connId, sock] of connMap.entries()) {
    if (sock.home === homeHash) {
      try {

        sock.disconnect(true);
      } catch (e) {
        /* ignore */
      }
      connMap.delete(connId);
    }
  }

  users = users.filter(u => u.home !== homeHash);
  io.emit('update users', users);
  bannedHomes.add(homeHash);
  sys.log(`<strong>home ${homeHash} was banned</strong> — ${sanitizeHTML(reason)}`, true);
}
function startServer() {
  io.on('connection', (socket) => {
    const ip = socket.handshake.address || (socket.request && socket.request.connection && socket.request.connection.remoteAddress) || 'unknown';
    const homeHash = computeHomeFromIP(String(ip));

    // if a previous socket with the same homeHash is still tracked, clean it up immediately
    for (const [oldId, oldSock] of connMap.entries()) {
      if (oldSock.home === homeHash) {
        try { oldSock.disconnect(true); } catch (e) { /* ignore */ }
        connMap.delete(oldId);
      }
    }
    // also remove any stale user entries matching this home so we don't show clones
    users = users.filter(u => u.home !== homeHash);

    const connId = crypto.randomBytes(8).toString('hex');
    socket.home = homeHash;
    socket.connId = connId;
    if (authorizedHomes.has(homeHash)) {
      socket.isSuperuser = true;
      io.emit("edit user data", {
        isSuperuser: true,
        home: homeHash
      });
      io.emit('update users', users);
    }
    connMap.set(connId, socket);
    if (bannedHomes.has(socket.home)) {
      sys.sendLogToClient(socket, 'Hell can be dangerous, If you think you\'re safe, you\'re with <b>them.</b>', false);
      try {
        socket.disconnect(true);
      }
      catch (e) { /* ignore */ }
      return;
    };
    socket.on('user joined', (nick, color, style, pass) => {



      let safeNick = typeof nick === 'string' ? nick.trim() : '';
      if (safeNick.length === 0) safeNick = 'anonymous';
      safeNick = sanitizeHTML(safeNick).slice(0, NICK_MAX_LENGTH);

      const safeColor = sanitizeColor(color || '#ff0000');
      const safeStyle = sanitizeStyle(style || '');

      socket.nick = safeNick;
      socket.color = safeColor;
      socket.style = safeStyle;
      socket.pass = typeof pass === 'string' ? pass : undefined;


      const existingIndex = users.findIndex(u => u.connId === socket.connId);

      if (existingIndex !== -1) {
        const existingUser = users[existingIndex];

        if (existingUser.nick !== socket.nick) {
          io.emit('user change nick', [
            existingUser,
            { nick: socket.nick, color: socket.color, style: socket.style, home: socket.home, isSuperuser: socket.isSuperuser }
          ]);
        }

        users[existingIndex].nick = socket.nick;
        users[existingIndex].color = socket.color;
        users[existingIndex].style = socket.style;
        users[existingIndex].isSuperuser = socket.isSuperuser;

      } else {

        users.push({
          connId: socket.connId,
          home: socket.home,
          nick: socket.nick,
          color: socket.color,
          style: socket.style,
          isSuperuser: socket.isSuperuser
        });

        io.emit('user joined', {
          connId: socket.connId,
          home: socket.home,
          nick: socket.nick,
          color: socket.color,
          style: socket.style,
          isSuperuser: socket.isSuperuser
        });
      }


      io.emit('update users', users);
    });

    // allow clients to request their home!
    socket.on("my_home", () => {
      socket.emit("my_home", socket.home);
    });




    socket.on('message', (msg) => {
      if (!allowMessage(socket)) {
        socket.emit('server warning', 'You are sending messages too quickly. Slow down.');
        return;
      }
      if (typeof msg !== 'string') return;
      msg = msg.slice(0, MAX_MSG_LENGTH);


      if (msg.startsWith('/authorize ')) {
        const providedToken = msg.slice(11).trim();
        if (providedToken === token) {
          socket.isSuperuser = true;
          authorizedHomes.add(socket.home);
          sys.sendLogToClient(socket, 'Authorization successful. You have gained superuser privileges.', true);
          io.emit("edit user data", {
            isSuperuser: true
          });
          io.emit('update users', users);
          commitAuthorizedHomes();
        } else {
          sys.sendLogToClient(socket, 'Invalid token provided for authorization.', true);
        }
        return;
      }


      if (socket.isSuperuser) {
        if (msg.startsWith('/ban ')) {
          const input = msg.slice(5).trim();
          const homes = users.map(u => u.home);
          const targetHome = homes.find(home => checkHash(home, input));

          /* TODO if (targetHome) {
             if (targetHome === socket.home) {
               sys.sendLogToClient(socket, 'Yo, what are you doing ?', true);
               return;
             }
             banHome(targetHome, 'banned by superuser (hash match)');
             return;
           }
         */

          const targetUser = users.find(u => u.nick === input);

          if (targetUser && targetUser.nick === socket.nick) {
            sys.sendLogToClient(socket, 'Yo, what are you doing ?', true);
            return;
          }

          if (targetUser) {
            banHome(targetUser.home, 'banned by superuser');
            commitBannedHomes();
          } else {
            sys.sendLogToClient(socket, `User with nick "${sanitizeHTML(input)}" not found.`, true);
          }

          return;
        } else if (msg.startsWith('/sendservercode ')) {
          try {
            const codeToEval = msg.slice(16).trim();
            const evalResult = eval(codeToEval);
            sys.sendLogToClient(socket, `Eval result: ${String(evalResult)}`, false);
          } catch (e) {
            sys.sendLogToClient(socket, `<span style='color:red'>ERROR!</span> ${e.stack}`, false);
          }
          return;
        }
      }


      const messageData = {
        date: Date.now(),
        nick: socket.nick || 'anonymous',
        color: socket.color || '#ffffff',
        style: socket.style || '',
        home: socket.home,
        connId: socket.connId,
        isSuperuser: socket.isSuperuser,
        msg: sanitizeHTML(msg)
      };

      messages.push(messageData);
      if (messages.length > MAX_HISTORY) messages.shift();

      io.emit('message', messageData);
    });

    socket.on('disconnect', () => {
      users = users.filter(u => u.connId !== socket.connId);
      connMap.delete(socket.connId);
      io.emit('update users', users);
      io.emit('user left', {
        connId: socket.connId,
        home: socket.home,
        nick: socket.nick,
        color: socket.color,
        isSuperuser: socket.isSuperuser
      });
    });



  });

  server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
}
let shuttingDown = false;

function shutdown() {
  if (shuttingDown) {
    console.log('Force quitting now!');
    process.exit(1); // force quit immediately
  }

  shuttingDown = true;
  console.log('Shutting down server...');
  io.emit('closing', {
    date: Date.now(),
    nick: "WARNING",
    home: "server",
    color: "crimson",
    msg: "<em>Server is shutting down...</em>"
  });

  setTimeout(() => {
    process.exit(0);
  }, 1000);
}

setInterval(() => {
  commitBannedHomes();
  commitAuthorizedHomes();
}, 1000 * 60);
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);