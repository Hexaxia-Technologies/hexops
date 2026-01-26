const { createServer } = require('http');
const { parse } = require('url');
const next = require('next');
const { WebSocketServer } = require('ws');
const pty = require('node-pty');

const dev = process.env.NODE_ENV !== 'production';
const hostname = 'localhost';
const port = parseInt(process.env.PORT || '3000', 10);

const app = next({ dev, hostname, port });
const handle = app.getRequestHandler();

// Shell sessions storage
const sessions = new Map();

app.prepare().then(() => {
  const upgradeHandler = app.getUpgradeHandler();
  const server = createServer(async (req, res) => {
    try {
      const parsedUrl = parse(req.url, true);
      await handle(req, res, parsedUrl);
    } catch (err) {
      console.error('Error occurred handling', req.url, err);
      res.statusCode = 500;
      res.end('internal server error');
    }
  });

  // WebSocket server for shell - noServer mode so we can handle upgrade manually
  const wss = new WebSocketServer({ noServer: true });

  // Handle WebSocket upgrades
  server.on('upgrade', (req, socket, head) => {
    const { pathname } = parse(req.url, true);

    if (pathname === '/api/shell/ws') {
      // Handle shell WebSocket
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit('connection', ws, req);
      });
    } else {
      // Let Next.js handle HMR and other WebSocket connections
      upgradeHandler(req, socket, head);
    }
  });

  wss.on('connection', (ws, req) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const cwd = url.searchParams.get('cwd') || process.cwd();
    const sessionId = `shell-${Date.now()}`;

    console.log(`Shell session ${sessionId} starting in ${cwd}`);

    const shell = process.env.SHELL || '/bin/bash';

    const ptyProcess = pty.spawn(shell, [], {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd,
      env: {
        ...process.env,
        TERM: 'xterm-256color',
      },
    });

    sessions.set(sessionId, { pty: ptyProcess, ws });

    // Send data from pty to websocket
    ptyProcess.onData((data) => {
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({ type: 'output', data }));
      }
    });

    ptyProcess.onExit(({ exitCode }) => {
      console.log(`Shell session ${sessionId} exited with code ${exitCode}`);
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({ type: 'exit', code: exitCode }));
      }
      sessions.delete(sessionId);
    });

    // Handle messages from websocket
    ws.on('message', (message) => {
      try {
        const msg = JSON.parse(message.toString());

        switch (msg.type) {
          case 'input':
            ptyProcess.write(msg.data);
            break;
          case 'resize':
            if (msg.cols && msg.rows) {
              ptyProcess.resize(msg.cols, msg.rows);
            }
            break;
        }
      } catch (err) {
        console.error('Error processing message:', err);
      }
    });

    ws.on('close', () => {
      console.log(`Shell session ${sessionId} closed`);
      ptyProcess.kill();
      sessions.delete(sessionId);
    });

    ws.on('error', (err) => {
      console.error(`Shell session ${sessionId} error:`, err);
      ptyProcess.kill();
      sessions.delete(sessionId);
    });

    // Send ready message
    ws.send(JSON.stringify({ type: 'ready', sessionId, cwd }));
  });

  server.listen(port, () => {
    console.log(`> Ready on http://${hostname}:${port}`);
    console.log(`> Shell WebSocket available at ws://${hostname}:${port}/api/shell/ws`);
  });
});
