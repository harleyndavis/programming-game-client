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
    treekill: true,
    shutdown_with_message: true,
    // pm2 does not timestamp captured stdout/stderr by default, so a native
    // crash trace (V8 OOM, uncaught exception) has no wall-clock time of its
    // own once printed — undateable after the fact. log_date_format prefixes
    // every captured line with one. out_file/error_file put them in the
    // project's existing logs/ dir instead of pm2's own ~/.pm2/logs/, so
    // crash output sits next to overworld.log with the same rotation home.
    log_date_format: 'YYYY-MM-DD HH:mm:ss.SSS Z',
    out_file: './logs/pm2-out.log',
    error_file: './logs/pm2-error.log',
    merge_logs: true,
  }],
};
