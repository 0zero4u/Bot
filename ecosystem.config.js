// ecosystem.config.js
module.exports = {
  apps: [
    {
      name: 'bybit-listener',
      script: 'bybit_listener.js',
      watch: false,
      restart_delay: 5000,
      env: {
        NODE_ENV: 'production',
      },
    },
    {
      name: 'delta-trader',
      script: 'trader.js',
      watch: false,
      restart_delay: 5000,
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};
