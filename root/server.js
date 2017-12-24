// This file is part of MusicBrainz, the open internet music database.
// Copyright (C) 2015 MetaBrainz Foundation
// Licensed under the GPL version 2, or (at your option) any later version:
// http://www.gnu.org/licenses/gpl-2.0.txt

'use strict';

require('babel-core/register');

const Raven = require('raven');
const DBDefs = require('./static/scripts/common/DBDefs');
Raven.config(DBDefs.SENTRY_DSN).install();

const cluster = require('cluster');
const fs = require('fs');
const spawnSync = require('child_process').spawnSync;
const _ = require('lodash');

const createServer = require('./server/createServer');
const gettext = require('./server/gettext');
const {clearRequireCache} = require('./server/utils');

const yargs = require('yargs')
  .option('socket', {
    alias: 's',
    default: DBDefs.RENDERER_SOCKET,
    describe: 'UNIX socket path',
  })
  .option('workers', {
    alias: 'w',
    default: process.env.RENDERER_WORKERS || 1,
    describe: 'Number of workers to spawn',
  });

const SOCKET_PATH = yargs.argv.socket;
const WORKER_COUNT = yargs.argv.workers;

if (cluster.isMaster) {
  if (fs.existsSync(SOCKET_PATH)) {
    if (spawnSync('lsof', [SOCKET_PATH]).status) {
      fs.unlinkSync(SOCKET_PATH);
    } else {
      console.error('socket ' + SOCKET_PATH + ' exists and is in use');
      process.exit(1);
    }
  }

  function forkWorker(listening) {
    // Allow spawning one additional worker during HUP.
    if (_.keys(cluster.workers).length > WORKER_COUNT) {
      return false;
    }

    const worker = cluster.fork();

    if (listening) {
      worker.once('listening', listening);
    }

    worker.on('exit', function (code, signal) {
      if (signal) {
        console.info(`worker was killed by signal: ${signal}`);
      } else if (code !== 0) {
        console.info(`worker exited with error code: ${code}`);
      }
      if (!worker.noRespawn) {
        forkWorker();
      }
    });

    return true;
  }

  for (let i = 0; i < WORKER_COUNT; i++) {
    forkWorker();
  }

  console.log(`server.js listening on ${SOCKET_PATH} (pid ${process.pid})`);

  function killWorker(worker, signal) {
    worker.noRespawn = true;
    if (!worker.isDead()) {
      const proc = worker.process;
      console.info('sending ' + signal + ' to worker ' + proc.pid);
      proc.kill(signal);
    }
  }

  const cleanup = Raven.wrap(function (signal) {
    for (const id in cluster.workers) {
      killWorker(cluster.workers[id], signal);
    }
    process.exit();
  });

  let hupAction = null;
  const hup = Raven.wrap(function () {
    console.info('master received SIGHUP; restarting workers');

    let oldWorkers;
    let initialTimeout = 0;

    if (hupAction) {
      clearTimeout(hupAction);
      initialTimeout = 2000;
    }

    const killNext = Raven.wrap(function () {
      if (!oldWorkers) {
        oldWorkers = _.values(cluster.workers);
      }
      const oldWorker = oldWorkers.pop();
      if (oldWorker) {
        const doKill = function () {
          killWorker(oldWorker, 'SIGTERM');
          hupAction = setTimeout(killNext, 1000);
        };
        if (!forkWorker(doKill)) {
          doKill();
        }
      } else {
        hupAction = null;
      }
    });

    hupAction = setTimeout(killNext, initialTimeout);
  });

  process.on('SIGINT', () => cleanup('SIGINT'));
  process.on('SIGTERM', () => cleanup('SIGTERM'));
  process.on('SIGHUP', hup);
} else {
  const socketServer = createServer(SOCKET_PATH);

  const cleanup = Raven.wrap(function () {
    socketServer.close(function () {
      process.exit();
    });
  });

  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
}
