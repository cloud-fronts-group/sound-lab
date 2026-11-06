#!/usr/bin/env node
'use strict';
// Stand-in for the server.js of a standalone Next.js build (`output: "standalone"`): listens on $HOSTNAME:$PORT
// (defaults 0.0.0.0:3000, as Next does) and answers 200 to everything. Tests copy it into a fake prebuilt bundle.
const http = require('http');
const port = parseInt(process.env.PORT || '3000', 10);
const host = process.env.HOSTNAME || '0.0.0.0';
http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(`<!doctype html><title>mlx-audio Studio (fixture)</title><p>pid ${process.pid} on ${host}:${port} ${req.url}`);
}).listen(port, host, () => process.stderr.write(`studio fixture listening on http://${host}:${port}\n`));
