// strategies/MomentumRiderStrategy.js

const { v4: uuidv4 } = require('uuid');

class MomentumRiderStrategy {

  constructor(bot) {
    this.bot = bot;
    this.logger = bot.logger;
    this.position = null;
    this.isExitInProgress = false;
    this.lastEntrySignalPrice = null;
    
    // NEW: Properties to signal intent to the trader bot
    this.hasBracketOrders = false; // This strategy does not use a TP bracket
    this.hasFailSafeStop = true;   // It does require a fail-safe SL
    this.lastCalculatedStopLoss = null; // Store the calculated SL price
  }

  getName() { return "MomentumRiderStrategy"; }

  async onPriceUpdate(currentPrice, priceDifference) {
    // FIX: Only allow entry if BOTH local AND exchange state are flat
    if (this.position || this.bot.hasOpenPosition) {
      this.manageOpenPosition(currentPrice);
    } else {
      await this.tryEnterPosition(currentPrice);
    }
  }

  onPositionUpdate(positionUpdate) {
    const positionSize = parseFloat(positionUpdate.size);
    const positionIsOpen = positionSize !== 0;

    // This can be triggered by REST or WS, find the correct entry price source
    const entryPrice = positionUpdate.entry_price || positionUpdate.avg_entry_price;

    if (positionIsOpen && !this.position) {
      this.position = {
        side: positionSize > 0 ? 'buy' : 'sell',
        entryPrice: parseFloat(entryPrice),
        size: Math.abs(positionSize),
        peakPrice: this.lastEntrySignalPrice || parseFloat(entryPrice)
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
      this.lastCalculatedStopLoss = null; // Clear SL on position close
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
    const clientOrderId = `entry-${uuidv4()}`;

    try {
      const side = currentPrice > this.bot.priceAtLastTrade ? 'buy' : 'sell';
      if (!this.bot.isOrderbookReady || !this.bot.orderBook.bids?.[0]?.[0] || !this.bot.orderBook.asks?.[0]?.[0]) {
        throw new Error("Delta L1 order book is not ready. Cannot calculate a safe SL.");
      }

      const deltaReferencePrice = side === 'buy'
        ? parseFloat(this.bot.orderBook.bids[0][0])
        : parseFloat(this.bot.orderBook.asks[0][0]);
      
      const stopLossPrice = side === 'buy'
        ? deltaReferencePrice - this.bot.config.stopLossOffset
        : deltaReferencePrice + this.bot.config.stopLossOffset;

      if (stopLossPrice <= 0) {
        this.logger.error(`[${this.getName()}] ABORTING: Invalid Stop-Loss Price (<=0) calculated from Delta BBO.`, { deltaReferencePrice, stopLossPrice });
        this.bot.isOrderInProgress = false;
        return;
      }
      
      // Store the SL price so the trader can use it after the main order fills
      this.lastCalculatedStopLoss = stopLossPrice;

      // MODIFIED: Removed deprecated `bracket_stop_loss_price`
      const orderData = {
        product_id: this.bot.config.productId,
        size: this.bot.config.orderSize,
        side,
        order_type: 'market_order',
        client_order_id: clientOrderId,
      };

      this.logger.info(`[${this.getName()}] Placing entry market order. Fail-safe SL will be attached upon fill.`, {
        signalPrice: currentPrice,
        deltaBBO: deltaReferencePrice,
        calculatedStopLoss: stopLossPrice.toFixed(4),
        clientOrderId: clientOrderId
      });
      
      this.lastEntrySignalPrice = currentPrice;
      this.bot.registerPendingOrder(clientOrderId, 'main'); // Manually register as pending
      const response = await this.bot.placeOrder(orderData);

      if (response.result) {
        this.logger.info(`[${this.getName()}] Entry order placed successfully. Waiting for fill to attach SL.`);
        this.bot.priceAtLastTrade = currentPrice;
      } else {
        this.bot.cancelPendingOrder(clientOrderId); // Cancel if placement failed
        this.lastEntrySignalPrice = null;
        this.lastCalculatedStopLoss = null;
        throw new Error(JSON.stringify(response));
      }

    } catch (error) {
      this.lastEntrySignalPrice = null;
      this.lastCalculatedStopLoss = null;
      this.bot.cancelPendingOrder(clientOrderId);
      
      let response;
      try {
        response = JSON.parse(error.message);
      } catch (e) {
        this.logger.error(`[${this.getName()}] Unparseable or critical error during position entry:`, { message: error.message });
        this.bot.isOrderInProgress = false;
        return;
      }

      if (response && response.error && response.error.code === 'bracket_order_position_exists' || response.error.code === 'position_non_zero_size_for_reduce_only' ) {
        this.logger.warn(`[${this.getName()}] State mismatch detected: Exchange reports an open position. Forcing state correction.`);
        await this.bot.forceStateCorrection();
      } else {
        this.logger.error(`[${this.getName()}] Exchange rejected order to enter position:`, { response });
      }
      this.bot.isOrderInProgress = false;
    } 
    // Do not set isOrderInProgress to false here, let the fill/fail logic handle it
  }

  async exitPosition() {
    if (!this.position || this.isExitInProgress) return;
    this.isExitInProgress = true;
    this.logger.warn(`[${this.getName()}] Algorithmic exit triggered. Cancelling all open orders for ${this.bot.config.productSymbol} to remove any hard SL.`);
    await this.bot.safeCancelAll(this.bot.config.productId);
    this.logger.info(`[${this.getName()}] Proceeding with market exit order.`);
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
        throw new Error(`Exchange rejected algorithmic exit order: ${JSON.stringify(response)}`);
      }
      this.logger.info(`[${this.getName()}] Algorithmic exit order to close position has been placed.`);
    } catch (error) {
      this.logger.error(`[${this.getName()}] CRITICAL: Failed to place algorithmic exit order. Manual intervention may be required.`, { message: error.message });
    }
  }
}

module.exports = MomentumRiderStrategy;
