#!/bin/bash
cd /home/arshhtripathi/Bot

# Delete old data
rm -f delta_xrp_trades.csv binance_xrp_bookticker.csv live-bot.log

# Start live bot in background
node trader.js > live-bot.log 2>&1 &
BOT_PID=$!
echo "Bot started (PID: $BOT_PID)"

# Run data recorder for 180 seconds
DURATION_MS=180000 node record-xrp.js

# Stop bot
kill $BOT_PID 2>/dev/null
echo "Bot stopped."

# Run simulation on captured data
node test-momentum-simple-aligned.js

# Show live bot results
echo ""
echo "=== LIVE BOT LOG ==="
tail -50 live-bot.log
