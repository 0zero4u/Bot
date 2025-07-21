// ecosystem.config.js
module.exports = {
  apps: [
    {
      name: 'bybit-listener',
      script: 'bybit_listener.js',
      // This is correct and necessary for robust pathing
      cwd: '/home/arshtripathi/trading-bot/Bot/', 
      watch: false,
      restart_delay: 5000,
      max_restarts: 10,
      min_uptime: '10s',
      env: {
        NODE_ENV: 'production',
      },
      error_file: './logs/bybit-listener-error.log',
      out_file: './logs/bybit-listener-out.log',
      log_file: './logs/bybit-listener-combined.log',
      time: true
    },
    {
      name: 'delta-trader',
      script: 'trader.js',
      // This is correct and necessary for robust pathing
      cwd: '/home/arshtripathi/trading-bot/Bot/',
      watch: false,
      restart_delay: 5000,
      max_restarts: 10,
      min_uptime: '10s',
      env: {
        NODE_ENV: 'production',
      },
      error_file: './logs/delta-trader-error.log',
      out_file: './logs/delta-trader-out.log',
      log_file: './logs/delta-trader-combined.log',
      time: true
    },
  ],
};
