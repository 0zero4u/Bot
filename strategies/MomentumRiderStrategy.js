// strategies/MomentumRiderStrategy.js
// Version 2.0.0 - UPGRADED to a Trailing Stop-Loss Mechanism
// This strategy now truly "rides the momentum" by trailing the stop-loss.

class MomentumRiderStrategy {
    constructor(bot) {
        this.bot = bot;
        this.logger = bot.logger;
        this.position = null;
        this.isExitInProgress = false;
        // This will temporarily hold the signal price that triggered a potential entry.
        this.lastEntrySignalPrice = null;
    }

    getName() { return "MomentumRiderStrategy"; }

    async onPriceUpdate(currentPrice, priceDifference) {
        if (this.position) {
            this.manageOpenPosition(currentPrice);
        } else {
            await this.tryEnterPosition(currentPrice);
        }
    }

    onPositionUpdate(positionUpdate) {
        const positionSize = parseFloat(positionUpdate.size);
        const positionIsOpen = positionSize !== 0;

        if (positionIsOpen && !this.position) {
            this.position = {
                side: positionSize > 0 ? 'buy' : 'sell',
                entryPrice: parseFloat(positionUpdate.entry_price),
                size: Math.abs(positionSize),
                // This is the highest price (for a long) or lowest price (for a short) seen so far.
                // We initialize it with the price that triggered the trade.
                peakPrice: this.lastEntrySignalPrice 
            };
            this.logger.info(`[${this.getName()}] STRATEGY POSITION SYNCED: Side=${this.position.side}, Entry Price=${this.position.entryPrice}. Trailing stop initialized at peak price: ${this.position.peakPrice}`);
        
        } else if (!positionIsOpen && this.position) {
            this.logger.info(`[${this.getName()}] STRATEGY POSITION CLEARED.`);
            this.position = null;
            this.isExitInProgress = false;
            this.lastEntrySignalPrice = null;
        }
    }

    /**
     * CORE LOGIC: This function now implements the trailing stop-loss.
     */
    manageOpenPosition(currentPrice) {
        // Guard clauses: Do nothing if no position, exit is busy, or we can't manage it.
        if (!this.position || this.isExitInProgress || !this.position.peakPrice) {
            // This handles the edge case of a bot restart with an existing position.
            return;
        }

        let drawdown = 0;

        // Logic for a LONG ('buy') position
        if (this.position.side === 'buy') {
            // If the price hits a new high, we update our peak and trail the stop up.
            if (currentPrice > this.position.peakPrice) {
                this.logger.info(`[${this.getName()}] New peak price for LONG: ${currentPrice} (previous: ${this.position.peakPrice})`);
                this.position.peakPrice = currentPrice;
            }
            // Calculate how far the price has dropped from its peak.
            drawdown = this.position.peakPrice - currentPrice;
        
        // Logic for a SHORT ('sell') position
        } else { 
            // If the price hits a new low, we update our peak (a new low) and trail the stop down.
            if (currentPrice < this.position.peakPrice) {
                this.logger.info(`[${this.getName()}] New peak price for SHORT: ${currentPrice} (previous: ${this.position.peakPrice})`);
                this.position.peakPrice = currentPrice;
            }
            // Calculate how far the price has risen from its lowest point.
            drawdown = currentPrice - this.position.peakPrice;
        }

        // Check if the reversal has exceeded our allowed threshold from the config
        if (drawdown >= this.bot.config.momentumReversalThreshold) {
            this.logger.warn(`[${this.getName()}] TRAILING STOP TRIGGERED! Peak: ${this.position.peakPrice}, Current: ${currentPrice}. Drawdown (${drawdown.toFixed(2)}) >= Threshold (${this.bot.config.momentumReversalThreshold}). Exiting.`);
            this.exitPosition();
        }
    }

    async tryEnterPosition(currentPrice
