import dgram from 'dgram';
import { EventEmitter } from 'events';

export interface DiscoveredRadio {
    ip: string;
    port: number;
    nickname?: string;
    model?: string;
    serial?: string;
    callsign?: string;
}

export class FlexDiscovery extends EventEmitter {
    private socket: dgram.Socket | null = null;
    private discoveredRadios: Map<string, DiscoveredRadio> = new Map();

    /**
     * Discover FlexRadio devices on the network.
     * FlexRadio broadcasts discovery packets on UDP port 4992.
     * @param timeout Timeout in milliseconds (default: 3000)
     * @returns Promise with first discovered radio, or null if none found
     */
    public async discoverRadio(timeout: number = 3000): Promise<DiscoveredRadio | null> {
        return new Promise((resolve) => {
            this.socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });

            const timeoutId = setTimeout(() => {
                this.close();
                // Return first discovered radio or null
                const radios = Array.from(this.discoveredRadios.values());
                resolve(radios.length > 0 ? radios[0] : null);
            }, timeout);

            this.socket.on('message', (msg, rinfo) => {
                const radio = this.parseDiscoveryPacket(msg, rinfo);
                if (radio) {
                    this.discoveredRadios.set(radio.ip, radio);
                    console.log(`Discovered FlexRadio at ${radio.ip}: ${radio.nickname || radio.model || 'Unknown'}`);

                    // Resolve immediately on first discovery
                    clearTimeout(timeoutId);
                    this.close();
                    resolve(radio);
                }
            });

            this.socket.on('error', (err) => {
                console.error('Discovery error:', err);
                clearTimeout(timeoutId);
                this.close();
                resolve(null);
            });

            this.socket.bind(4992, () => {
                console.log('Listening for FlexRadio discovery broadcasts...');
            });
        });
    }

    private parseDiscoveryPacket(msg: Buffer, rinfo: dgram.RemoteInfo): DiscoveredRadio | null {
        try {
            const data = msg.toString();

            // FlexRadio discovery packets contain key=value pairs
            // Example: discovery_protocol_version=3.0.0.1 model=FLEX-6600 serial=... ip=... port=4992
            if (!data.includes('discovery_protocol_version')) {
                return null;
            }

            const radio: DiscoveredRadio = {
                ip: rinfo.address,
                port: 4992
            };

            // Parse key=value pairs
            const pairs = data.split(' ');
            for (const pair of pairs) {
                const [key, value] = pair.split('=');
                if (!key || !value) continue;

                switch (key) {
                    case 'ip':
                        radio.ip = value;
                        break;
                    case 'port':
                        radio.port = parseInt(value) || 4992;
                        break;
                    case 'nickname':
                        radio.nickname = value;
                        break;
                    case 'model':
                        radio.model = value;
                        break;
                    case 'serial':
                        radio.serial = value;
                        break;
                    case 'callsign':
                        radio.callsign = value;
                        break;
                }
            }

            return radio;
        } catch (error) {
            return null;
        }
    }

    public close(): void {
        if (this.socket) {
            try {
                this.socket.close();
            } catch (e) {
                // Ignore
            }
            this.socket = null;
        }
    }

    public getDiscoveredRadios(): DiscoveredRadio[] {
        return Array.from(this.discoveredRadios.values());
    }
}

/**
 * Convenience function to discover a FlexRadio
 */
export async function discoverFlexRadio(timeout: number = 3000): Promise<DiscoveredRadio | null> {
    const discovery = new FlexDiscovery();
    const radio = await discovery.discoverRadio(timeout);
    return radio;
}
