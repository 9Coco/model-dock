// SPDX-License-Identifier: GPL-3.0-or-later
import type { GatewayStatus, RuntimeSnapshot } from '../shared/types';
import { FlowBridgeManager, type FlowBridgeOptions } from './flowbridge';
import type { Gateway } from './gateway';
import type { SettingsStore } from './settings';

/** The main window, tray and tool sync all operate on this application's services. */
export class ModelDockRuntime {
  readonly network: FlowBridgeManager;
  private pendingGateway: Promise<unknown> = Promise.resolve();
  private closing = false;

  constructor(readonly gateway: Gateway, store: SettingsStore, options: Omit<FlowBridgeOptions, 'gatewayPort'>) {
    this.network = new FlowBridgeManager(store, { ...options, gatewayPort: () => gateway.status().port });
  }

  snapshot(): RuntimeSnapshot {
    return { gateway: this.gateway.status(), network: this.network.snapshot() };
  }

  private gatewayOperation(action: () => Promise<GatewayStatus>): Promise<GatewayStatus> {
    if (this.closing) return Promise.reject(new Error('ModelDock 正在退出。'));
    const result = this.pendingGateway.then(action);
    this.pendingGateway = result.catch(() => {});
    return result;
  }

  startGateway(port?: number): Promise<GatewayStatus> {
    return this.gatewayOperation(async () => {
      const current = this.gateway.status();
      if (current.running) return current;
      const requested = port ?? current.port;
      this.network.validateGatewayPort(requested);
      return this.gateway.start(requested);
    });
  }

  stopGateway(): Promise<GatewayStatus> {
    return this.gatewayOperation(() => this.gateway.stop());
  }

  async shutdown(): Promise<void> {
    this.closing = true;
    try {
      // Keep the gateway and the database available when restoring the desktop network needs a retry.
      await this.network.shutdown();
      await this.pendingGateway;
      await this.gateway.stop();
    } catch (error) {
      this.closing = false;
      throw error;
    }
  }
}
