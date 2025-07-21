// strategies/MomentumRiderStrategy.js
// Version 3.1.0 - Fixed trailing stop typo and reduced log noise.
const { v4: uuidv4 } = require('uuid');

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
                peakPrice: this.lastEntrySignalPrice,
                clientOrderId: positionUpdate.client_order_id,
            };
            this.logger.info(`[${this.getName()}] POSITION SYNCED. Side: ${this.position.side}, Size: ${this.position.size}, Entry: ${this.position.entryPrice}`);
        
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
            if (currentPrice > this.position.peakPrice) {
                this.logger.debug(`New peak price for long position: ${currentPrice}`);
                this.position.peakPrice = currentPrice;
            }
            // <<< CRITICAL FIX: Corrected typo from "peakPric" to "peakPrice" >>>
            drawdown = this.position.peakPrice - currentPrice;
        } else { // 'sell' side
            if (currentPrice < this.position.peakPrice) {
                this.logger.debug(`New peak price for short position: ${currentPrice}`);
                this.position.peakPrice = currentPrice;
            }
            drawdown = currentPrice - this.position.peakPrice;
        }

        if (drawdown >= this.bot.config.momentumReversalThreshold) {
            this.logger.warn(`[${this.getName()}] TRAILING STOP TRIGGERED! Peak: ${this.position.peakPrice}, Current: ${currentPrice}, Drawdown: ${drawdown.toFixed(2)}. Exiting.`);
            this.exitPosition();
        }
    }

    async tryEnterPosition(currentPrice) {
        this.bot.isOrderInProgress = true;
        const clientOrderId = uuidv4();
        try {
            const side = currentPrice > this.bot.priceAtLastTrade ? 'buy' : 'sell';
            const orderData = { 
                product_id: this.bot.config.productId, 
                size: this.bot.config.orderSize, 
                side, 
                order_type: 'market_order',
                client_order_id: clientOrderId,
            };
            
            this.lastEntrySignalPrice = currentPrice;
            this.bot.registerPendingOrder(clientOrderId);

            this.logger.info(`[${this.getName()}] Placing entry order...`);
            const response = await this.bot.placeOrder(orderData);

            if (response.result) {
                this.bot.confirmRegisteredOrder(clientOrderId, response.result);
                this.logger.info(`[${this.getName()}] Entry order placed successfully. Handing off to OrderManager to attach SL.`);
                this.bot.priceAtLastTrade = currentPrice;
            } else { 
                this.bot.cancelPendingOrder(clientOrderId);
                this.lastEntrySignalPrice = null;
                throw new Error(`Exchange rejected order: ${JSON.stringify(response)}`); 
            }
        } catch (error) {
            this.bot.cancelPendingOrder(clientOrderId);
            this.logger.error(`[${this.getName()}] Failed to enter position:`, { message: error.message });
            this.lastEntrySignalPrice = null;
        } finally {
            this.bot.isOrderInProgress = false;
        }
    }

    async exitPosition() {
        if (!this.position || this.isExitInProgress) return;
        this.isExitInProgress = true;
        
        await this.bot.cancelActiveStopLoss(this.position.clientOrderId);
        
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
            this.logger.info(`[${this.getName()}] Trailing exit order placed successfully.`);
        } catch (error) {
            this.logger.error(`[${this.getName()}] Failed to place trailing exit order:`, { message: error.message });
        }
    }
}
module.exports = MomentumRiderStrategy;
