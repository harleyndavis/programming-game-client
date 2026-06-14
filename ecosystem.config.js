module.exports = {
  apps: [{
    name: 'bot',
    script: './node_modules/ts-node/dist/bin.js',
    args: 'index.ts',
    watch: false,
    autorestart: true,
    restart_delay: 2000,
    max_restarts: 10,
    min_uptime: 5000,
    kill_timeout: 5000,
    shutdown_with_message: true,
  }],
};
