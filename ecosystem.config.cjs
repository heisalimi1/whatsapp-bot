module.exports = {
  apps: [{
    name: 'whatsapp-bot',
    script: 'bot.js',
    cwd: __dirname,
    instances: 1,
    exec_mode: 'fork',
    node_args: '--env-file=.env',
    autorestart: true,
    restart_delay: 5000,
    exp_backoff_restart_delay: 100,
    max_memory_restart: '500M',
    kill_timeout: 30000,
    watch: false,
    time: true,
    env_production: {
      NODE_ENV: 'production',
      DASHBOARD_HOST: '127.0.0.1',
      DASHBOARD_PORT: '3000',
      DASHBOARD_TRUST_PROXY: 'loopback'
    }
  }]
}
