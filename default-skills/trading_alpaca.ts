/** Alpaca Markets REST API client (paper + live). */

export interface AlpacaAccount {
  id: string;
  equity: number;
  cash: number;
  buying_power: number;
  portfolio_value: number;
  daytrade_count: number;
  last_equity: number;
}

export interface AlpacaPosition {
  symbol: string;
  qty: number;
  side: 'long' | 'short';
  avg_entry_price: number;
  current_price: number;
  unrealized_pl: number;
  unrealized_plpc: number;
  market_value: number;
}

export interface AlpacaOrder {
  id: string;
  symbol: string;
  side: 'buy' | 'sell';
  type: string;
  qty: number;
  filled_qty: number;
  status: string;
  limit_price: number | null;
  stop_price: number | null;
  created_at: string;
}

export interface AlpacaBar {
  t: string; o: number; h: number; l: number; c: number; v: number;
}

export class AlpacaClient {
  private baseUrl:  string;
  private dataUrl = 'https://data.alpaca.markets';
  private headers:  Record<string, string>;

  constructor() {
    const key    = process.env['ALPACA_API_KEY'];
    const secret = process.env['ALPACA_API_SECRET'];
    const paper  = (process.env['ALPACA_PAPER'] ?? 'true') !== 'false';
    if (!key || !secret) throw new Error('ALPACA_API_KEY and ALPACA_API_SECRET are required.');
    this.baseUrl = paper
      ? 'https://paper-api.alpaca.markets'
      : 'https://api.alpaca.markets';
    this.headers = {
      'APCA-API-KEY-ID':     key,
      'APCA-API-SECRET-KEY': secret,
      'Content-Type':        'application/json',
    };
  }

  private async get<T>(url: string): Promise<T> {
    const res = await fetch(url, { headers: this.headers, signal: AbortSignal.timeout(10000) });
    if (!res.ok) throw new Error(`Alpaca API ${res.status}: ${await res.text()}`);
    return res.json() as Promise<T>;
  }

  private async post<T>(url: string, body: unknown): Promise<T> {
    const res = await fetch(url, {
      method: 'POST', headers: this.headers,
      body: JSON.stringify(body), signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) throw new Error(`Alpaca API ${res.status}: ${await res.text()}`);
    return res.json() as Promise<T>;
  }

  private async del(url: string): Promise<void> {
    const res = await fetch(url, { method: 'DELETE', headers: this.headers, signal: AbortSignal.timeout(10000) });
    if (!res.ok && res.status !== 204) throw new Error(`Alpaca API ${res.status}: ${await res.text()}`);
  }

  async getAccount(): Promise<AlpacaAccount> {
    const d = await this.get<Record<string, unknown>>(`${this.baseUrl}/v2/account`);
    return {
      id:              String(d['id']),
      equity:          parseFloat(String(d['equity'])),
      cash:            parseFloat(String(d['cash'])),
      buying_power:    parseFloat(String(d['buying_power'])),
      portfolio_value: parseFloat(String(d['portfolio_value'])),
      daytrade_count:  Number(d['daytrade_count']),
      last_equity:     parseFloat(String(d['last_equity'])),
    };
  }

  async getPositions(): Promise<AlpacaPosition[]> {
    const data = await this.get<Record<string, unknown>[]>(`${this.baseUrl}/v2/positions`);
    return data.map(d => ({
      symbol:          String(d['symbol']),
      qty:             parseFloat(String(d['qty'])),
      side:            String(d['side']) as 'long' | 'short',
      avg_entry_price: parseFloat(String(d['avg_entry_price'])),
      current_price:   parseFloat(String(d['current_price'])),
      unrealized_pl:   parseFloat(String(d['unrealized_pl'])),
      unrealized_plpc: parseFloat(String(d['unrealized_plpc'])),
      market_value:    parseFloat(String(d['market_value'])),
    }));
  }

  async getOrders(status = 'open'): Promise<AlpacaOrder[]> {
    const data = await this.get<Record<string, unknown>[]>(
      `${this.baseUrl}/v2/orders?status=${status}&limit=50`
    );
    return data.map(d => ({
      id:          String(d['id']),
      symbol:      String(d['symbol']),
      side:        String(d['side']) as 'buy' | 'sell',
      type:        String(d['type']),
      qty:         parseFloat(String(d['qty'])),
      filled_qty:  parseFloat(String(d['filled_qty'] ?? '0')),
      status:      String(d['status']),
      limit_price: d['limit_price'] ? parseFloat(String(d['limit_price'])) : null,
      stop_price:  d['stop_price']  ? parseFloat(String(d['stop_price']))  : null,
      created_at:  String(d['created_at']),
    }));
  }

  async getQuote(symbol: string): Promise<{ bid: number; ask: number; price: number }> {
    const d = await this.get<Record<string, unknown>>(
      `${this.dataUrl}/v2/stocks/${symbol}/quotes/latest?feed=iex`
    );
    const q = (d['quote'] ?? d) as Record<string, unknown>;
    const bid = parseFloat(String(q['bp'] ?? q['bid_price'] ?? '0'));
    const ask = parseFloat(String(q['ap'] ?? q['ask_price'] ?? '0'));
    return { bid, ask, price: (bid + ask) / 2 || bid || ask };
  }

  async getBars(symbol: string, timeframe = '1Day', limit = 60): Promise<AlpacaBar[]> {
    const d = await this.get<Record<string, unknown>>(
      `${this.dataUrl}/v2/stocks/${symbol}/bars?timeframe=${timeframe}&limit=${limit}&feed=iex&sort=asc`
    );
    const bars = (d['bars'] as Record<string, unknown>[]) ?? [];
    return bars.map(b => ({
      t: String(b['t']), o: Number(b['o']), h: Number(b['h']),
      l: Number(b['l']), c: Number(b['c']), v: Number(b['v']),
    }));
  }

  async getNews(symbol: string, limit = 5): Promise<Array<{ headline: string; summary: string; url: string; created_at: string }>> {
    const d = await this.get<Record<string, unknown>>(
      `${this.dataUrl}/v1beta1/news?symbols=${symbol}&limit=${limit}`
    );
    const news = (d['news'] as Record<string, unknown>[]) ?? [];
    return news.map(n => ({
      headline:   String(n['headline'] ?? ''),
      summary:    String(n['summary'] ?? ''),
      url:        String(n['url'] ?? ''),
      created_at: String(n['created_at'] ?? ''),
    }));
  }

  async placeOrder(params: {
    symbol: string; side: 'buy' | 'sell'; qty: number;
    type: 'market' | 'limit' | 'stop' | 'stop_limit';
    limit_price?: number; stop_price?: number;
    take_profit?: number; stop_loss?: number;
    time_in_force?: string;
  }): Promise<AlpacaOrder> {
    const body: Record<string, unknown> = {
      symbol:        params.symbol,
      qty:           String(params.qty),
      side:          params.side,
      type:          params.type,
      time_in_force: params.time_in_force ?? 'day',
    };
    if (params.limit_price) body['limit_price'] = String(params.limit_price);
    if (params.stop_price)  body['stop_price']  = String(params.stop_price);
    if (params.take_profit || params.stop_loss) {
      body['order_class'] = 'bracket';
      if (params.take_profit) body['take_profit'] = { limit_price: String(params.take_profit) };
      if (params.stop_loss)   body['stop_loss']   = { stop_price: String(params.stop_loss) };
    }
    const d = await this.post<Record<string, unknown>>(`${this.baseUrl}/v2/orders`, body);
    return {
      id: String(d['id']), symbol: String(d['symbol']),
      side: String(d['side']) as 'buy' | 'sell', type: String(d['type']),
      qty: parseFloat(String(d['qty'])), filled_qty: parseFloat(String(d['filled_qty'] ?? '0')),
      status: String(d['status']),
      limit_price: d['limit_price'] ? parseFloat(String(d['limit_price'])) : null,
      stop_price:  d['stop_price']  ? parseFloat(String(d['stop_price']))  : null,
      created_at: String(d['created_at']),
    };
  }

  async closePosition(symbol: string, qty?: number): Promise<void> {
    const url = qty
      ? `${this.baseUrl}/v2/positions/${symbol}?qty=${qty}`
      : `${this.baseUrl}/v2/positions/${symbol}`;
    await this.del(url);
  }

  async cancelOrder(orderId: string): Promise<void> {
    await this.del(`${this.baseUrl}/v2/orders/${orderId}`);
  }

  async replaceOrder(orderId: string, params: { stop_price?: number; limit_price?: number; qty?: number }): Promise<void> {
    await this.post(`${this.baseUrl}/v2/orders/${orderId}`, params);
  }

  isMarketOpen(): boolean {
    const now = new Date();
    const et  = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
    const day = et.getDay();
    if (day === 0 || day === 6) return false;
    const h = et.getHours(), m = et.getMinutes();
    const mins = h * 60 + m;
    return mins >= 9 * 60 + 30 && mins < 16 * 60;
  }

  /** True if within `bufferMins` of market open (9:30) or close (16:00) ET. */
  isNearMarketBoundary(bufferMins = 2): boolean {
    const now = new Date();
    const et  = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
    const h = et.getHours(), m = et.getMinutes();
    const mins = h * 60 + m;
    const open  = 9 * 60 + 30;
    const close = 16 * 60;
    return Math.abs(mins - open) <= bufferMins || Math.abs(mins - close) <= bufferMins;
  }

  /** Place an OCO (one-cancels-other) bracket on an existing position. */
  async placeBracketOnPosition(params: {
    symbol:     string;
    side:       'buy' | 'sell';   // sell for long, buy for short
    qty:        number;
    stop_loss:  number;
    take_profit: number;
  }): Promise<AlpacaOrder> {
    const body = {
      symbol:        params.symbol,
      qty:           String(params.qty),
      side:          params.side,
      type:          'limit',
      time_in_force: 'gtc',
      order_class:   'oco',
      stop_loss:     { stop_price: String(params.stop_loss) },
      take_profit:   { limit_price: String(params.take_profit) },
    };
    const d = await this.post<Record<string, unknown>>(`${this.baseUrl}/v2/orders`, body);
    return {
      id: String(d['id']), symbol: String(d['symbol']),
      side: String(d['side']) as 'buy' | 'sell', type: String(d['type']),
      qty: parseFloat(String(d['qty'])), filled_qty: 0,
      status: String(d['status']),
      limit_price: null, stop_price: null,
      created_at: String(d['created_at']),
    };
  }

  /** Cancel all open orders for a symbol (used before setting a new bracket). */
  async cancelOrdersForSymbol(symbol: string): Promise<number> {
    const orders = await this.getOrders('open');
    const matching = orders.filter(o => o.symbol === symbol);
    await Promise.all(matching.map(o => this.cancelOrder(o.id).catch(() => {})));
    return matching.length;
  }
}
