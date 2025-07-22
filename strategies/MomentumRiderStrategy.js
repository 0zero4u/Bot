// strategies/MomentumRiderStrategy.js
// Version 2.0.2 - Cooldown logic centralized in main bot

class MomentumRiderStrategy {
    constructor(bot) {
        this.bot = bot;
        this.logger = bot.logger;
        this.position = null;
        this.isExitInProgress = false;
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
                peakPrice: this.lastEntrySignalPrice 
            };
            this.logger.info(`[${this.getName()}] STRATEGY POSITION SYNCED. Trailing stop initialized at peak price: ${this.position.peakPrice}`);
        
        } else if (!positionIsOpen && this.position) {
            this.logger.info(`[${this.getName()}] STRATEGY POSITION CLEARED.`);
            this.position = null;
            this.isExitInProgress = false;
            this.lastEntrySignalPrice = null;
        }
    }

    manageOpenPosition(currentPrice) {
        if (!this.position || this.isExitInProgress || !this.position.peakPrice) return;

        let drawdown = 0;
        if (this.position.side === 'buy') {
            if (currentPrice > this.position.peakPrice) this.position.peakPrice = currentPrice;
            drawdown = this.position.peakPrice - currentPrice;
        } else { 
            if (currentPrice < this.position.peakPrice) this.position.peakPrice = currentPrice;
            drawdown = currentPrice - this.position.peakPrice;
        }

        if (drawdown >= this.bot.config.momentumReversalThreshold) {
            this.logger.warn(`[${this.getName()}] TRAILING STOP TRIGGERED! Peak: ${this.position.peakPrice}, Current: ${currentPrice}. Exiting.`);
            this.exitPosition();
        }
    }

    async tryEnterPosition(currentPrice) {
        this.bot.isOrderInProgress = true;
        try {
            const side = currentPrice > this.bot.priceAtLastTrade ? 'buy' : 'sell';
            const orderData = { 
                product_id: this.bot.config.productId, 
                size: this.bot.config.orderSize, 
                side, 
                order_type: 'market_order',
            };
            
            this.lastEntrySignalPrice = currentPrice;

            this.logger.info(`[${this.getName()}] Placing entry order...`);
            const response = await this.bot.placeOrder(orderData);

            if (response.result) {
                this.logger.info(`[${this.getName()}] Entry order placed successfully.`);
                this.bot.priceAtLastTrade = currentPrice;
            } else { 
                this.lastEntrySignalPrice = null;
                throw new Error(`Exchange rejected order: ${JSON.stringify(response)}`); 
            }
        } catch (error) {
            this.logger.error(`[${this.getName()}] Failed to enter position:`, { message: error.message });
            this.lastEntrySignalPrice = null;
        } finally {
            this.bot.isOrderInProgress = false;
        }
    }

    async exitPosition() {
        if (!this.position || this.isExitInProgress) return;
        this.isExitInProgress = true;
        const exitSide = this.position.side === 'buy' ? 'sell' : 'buy';
        try {
            const orderData = { 
                product_id: this.bot.config.productId, 
                size: this.position.size, 
                side: exitSide, 
                order_type: 'market_order',
                reduce_only: true 
            };
            const response = await this.bot.placeOrder(orderData);
            if (!response.result) {
                throw new Error(`Exchange rejected exit order: ${JSON.stringify(response)}`);
            }
            this.logger.info(`[${this.getName()}] Exit order placed successfully.`);
        } catch (error) {
            this.logger.error(`[${this.getName()}] Failed to place exit order:`, { message: error.message });
            this.isExitInProgress = false; 
        }
    }
}
module.exports = MomentumRiderStrategy;
