module.exports = {
  apps: [{
    name: 'popkidminibot',
    script: 'index.js',
    autorestart: true,
    restart_delay: 3000,
    exp_backoff_restart_delay: 200,
    max_memory_restart: process.env.MAX_MEMORY || '900M',
    kill_timeout: 10000
  }]
};
