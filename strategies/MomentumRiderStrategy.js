// strategies/MomentumRiderStrategy.js
// Version 5.1.0 - Correctly implements algorithmic exit by fetching and cancelling the hard SL.

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
                peakPrice: this.lastEntrySignalPrice
            };
            this.logger.info(`[${this.getName()}] POSITION SYNCED. Algorithmic trailing stop is now active.`, {
                entry: this.position.entryPrice,
                peak: this.position.peakPrice
            });
        
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
            this.logger.warn(`[${this.getName()}] ALGORITHMIC TRAILING STOP TRIGGERED! Peak: ${this.position.peakPrice}, Current: ${currentPrice}. Exiting.`);
            this.exitPosition();
        }
    }

    async tryEnterPosition(currentPrice) {
        this.bot.isOrderInProgress = true;
        try {
            const side = currentPrice > this.bot.priceAtLastTrade ? 'buy' : 'sell';
            const stopLossPrice = side === 'buy' ? currentPrice - this.bot.config.stopLossOffset : currentPrice + this.bot.config.stopLossOffset;

            if (stopLossPrice <= 0) {
                this.logger.error(`[${this.getName()}] ABORTING: Invalid Stop-Loss Price (<=0) calculated.`, { currentPrice, stopLossPrice });
                return;
            }
            
            const orderData = { 
                product_id: this.bot.config.productId, 
                size: this.bot.config.orderSize, 
                side, 
                order_type: 'market_order',
                bracket_stop_loss_price: stopLossPrice.toString()
            };
            
            this.logger.info(`[${this.getName()}] Placing ATOMIC market order with SERVER-SIDE fail-safe SL at ≈${stopLossPrice.toFixed(4)}.`);
            this.lastEntrySignalPrice = currentPrice;
            
            const response = await this.bot.placeOrder(orderData);

            if (response.result) {
                this.logger.info(`[${this.getName()}] Atomic entry order placed successfully. Exchange is managing the fail-safe SL.`);
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
        
        this.logger.warn(`[${this.getName()}] Algorithmic exit triggered. Fetching and cancelling hard SL before placing final exit order.`);
        
        try {
            // <<< THE DEFINITIVE FIX >>>
            // 1. Get all live orders for the symbol.
            const liveOrdersResponse = await this.bot.client.getLiveOrders(this.bot.config.productId);
            if (liveOrdersResponse.result && liveOrdersResponse.result.length > 0) {
                const orderIdsToCancel = liveOrdersResponse.result.map(o => o.id);
                this.logger.info(`[${this.getName()}] Found open orders to cancel: ${orderIdsToCancel.join(', ')}`);
                
                // 2. Batch cancel all found orders.
                await this.bot.client.batchCancelOrders(this.bot.config.productId, orderIdsToCancel);
                this.logger.info(`[${this.getName()}] Hard SL and any other open orders cancelled successfully.`);
            } else {
                this.logger.info(`[${this.getName()}] No open orders found to cancel.`);
            }
        } catch (error) {
            this.logger.error(`[${this.getName()}] Could not cancel hard SL, but proceeding with exit order anyway. Manual check may be required.`, { message: error.message });
        }
        
        const exitSide = this.position.side === 'buy' ? 'sell' : 'buy';
        try {
            // 3. Place the final market order to close the position.
            const orderData = { 
                product_id: this.bot.config.productId, 
                size: this.position.size, 
                side: exitSide, 
                order_type: 'market_order',
                reduce_only: true 
            };
            const response = await this.bot.placeOrder(orderData);
            if (!response.result) {
                throw new Error(`Exchange rejected algorithmic exit order: ${JSON.stringify(response)}`);
            }
            this.logger.info(`[${this.getName()}] Algorithmic exit order to close position has been placed.`);
        } catch (error) {
            this.logger.error(`[${this.getName()}] CRITICAL: Failed to place algorithmic exit order. Manual intervention may be required.`, { message: error.message });
        }
    }
}
module.exports = MomentumRiderStrategy;
