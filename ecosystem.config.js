// ecosystem.config.js
module.exports = {
  apps: [
    {
      name: 'market-listener',        // <--- UPDATED NAME
      script: 'market_listener.js',   // <--- UPDATED FILE (Very Important)
      cwd: '/home/arshhtripathi/trading-bot/Bot/', 
      watch: false,
      restart_delay: 5000,
      max_restarts: 10,
      min_uptime: '10s',
      env: {
        NODE_ENV: 'production',
      },
      // Updated log names so you don't mix old logs with new ones
      error_file: './logs/market-listener-error.log',
      out_file: './logs/market-listener-out.log',
      log_file: './logs/market-listener-combined.log',
      time: true
    },
    {
      name: 'delta-trader',
      script: 'trader.js',
      cwd: '/home/arshhtripathi/trading-bot/Bot/',
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
