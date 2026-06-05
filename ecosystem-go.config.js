module.exports = {
  apps: [{
    name: "go-executor",
    script: "./go-executor/executor",
    interpreter: "none",
    env: {
      DELTA_API_KEY: "qfvMkedn6I9xrprH1JqcWIPuXlLF7J",
      DELTA_API_SECRET: "3LM4Kdmj9TRSkuMp5SMjRdjVoq1rqgjkyUNH43YtJceeZWaLIpHB1lczpTVV",
      PORT: "8083"
    }
  }]
};
