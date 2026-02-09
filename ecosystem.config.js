module.exports = {
  apps: [
    {
      name: "market-listener",
      script: "./market_listener.js",
      cwd: "/home/ubuntu/trading-bot/Bot",
      restart_delay: 5000
    },
    {
      name: "delta-trader",
      script: "./trader.js",
      cwd: "/home/ubuntu/trading-bot/Bot",
      restart_delay: 5000
    },
    {
      name: "gateio-market-listener",
      script: "./gateIOmarket_listener.js",
      cwd: "/home/ubuntu/trading-bot/Bot",
      restart_delay: 5000
    }
  ]
};
