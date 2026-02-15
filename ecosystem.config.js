module.exports = {
  apps: [
    {
      name: "delta-trader",
      script: "./trader.js",
      cwd: "/home/ubuntu/trading-bot/Bot",
      restart_delay: 5000
    }
  ]
};
