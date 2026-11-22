// =============================================================================
// WebSocket Client Module: Real-time Data Streaming & Dispatcher
// =============================================================================

class WSClient {
  constructor() {
    this.ws = null;
    this.listeners = new Map();
    this.reconnectTimer = null;
    this.reconnectDelay = 2000;
  }

  connect() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}`;

    try {
      this.ws = new WebSocket(wsUrl);

      this.ws.onopen = () => {
        console.log('[WS] Connected to Edge Server:', wsUrl);
        const dot = document.getElementById('global-status-dot');
        const text = document.getElementById('global-server-text');
        if (dot) dot.style.background = '#059669';
        if (text) text.innerText = 'Connected';
        const pill = document.getElementById('global-status-pill');
        if (pill) { pill.classList.remove('is-offline'); pill.title = `Connected to the SHIRO server (${window.location.host}). Alarms arrive live.`; }

        if (this.reconnectTimer) {
          clearTimeout(this.reconnectTimer);
          this.reconnectTimer = null;
        }
      };

      this.ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          this.dispatch(msg.type, msg);
        } catch (err) {
          console.error('[WS] Failed to parse message:', err, event.data);
        }
      };

      this.ws.onclose = async (event) => {
        const dot = document.getElementById('global-status-dot');
        const text = document.getElementById('global-server-text');
        if (dot) dot.style.background = '#dc2626';
        if (text) text.innerText = 'Not connected – alarms cannot arrive. Reconnecting…';
        const pill = document.getElementById('global-status-pill');
        if (pill) pill.classList.add('is-offline');

        // 4001: the server ended this session's access (deactivated, password reset).
        // A refused reconnect also lands here: check the session before trying again.
        if (window.shiroAuth && !(await window.shiroAuth.stillSignedIn())) return;
        if (event && event.code === 4001) return;

        console.warn('[WS] Disconnected from Edge Server. Reconnecting in', this.reconnectDelay, 'ms...');
        this.scheduleReconnect();
      };

      this.ws.onerror = (err) => {
        console.error('[WS] WebSocket error:', err);
        if (this.ws) this.ws.close();
      };
    } catch (e) {
      console.error('[WS] Exception while connecting:', e);
      this.scheduleReconnect();
    }
  }

  scheduleReconnect() {
    if (!this.reconnectTimer) {
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        this.connect();
      }, this.reconnectDelay);
    }
  }

  on(type, callback) {
    if (!this.listeners.has(type)) {
      this.listeners.set(type, []);
    }
    this.listeners.get(type).push(callback);
  }

  dispatch(type, data) {
    const list = this.listeners.get(type);
    if (list) {
      list.forEach(cb => {
        try {
          cb(data);
        } catch (e) {
          console.error(`[WS] Error in listener for ${type}:`, e);
        }
      });
    }
  }

  send(data) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(typeof data === 'string' ? data : JSON.stringify(data));
    } else {
      console.warn('[WS] Cannot send message: WebSocket not open.');
    }
  }

  sendCalibration(A, n) {
    this.send({ action: 'UPDATE_CALIBRATION', A, n });
  }
}

// Global instance
window.wsClient = new WSClient();

