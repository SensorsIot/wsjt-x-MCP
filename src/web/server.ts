import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import http from 'http';
import path from 'path';
import { Config, saveConfig, loadConfig } from '../config';
import { WsjtxManager } from '../wsjtx/WsjtxManager';
import { SliceState, StationsUpdateMessage } from '../wsjtx/types';
import fs from 'fs';

export class WebServer {
    private app: express.Application;
    private server: http.Server;
    private wss: WebSocketServer;
    private config: Config;
    private wsjtxManager: WsjtxManager;

    constructor(config: Config, wsjtxManager: WsjtxManager) {
        this.config = config;
        this.wsjtxManager = wsjtxManager;
        this.app = express();
        this.server = http.createServer(this.app);
        this.wss = new WebSocketServer({ server: this.server });

        this.setupMiddleware();
        this.setupRoutes();
        this.setupWebSockets();
    }

    private setupMiddleware() {
        // Enable CORS for development
        this.app.use((req, res, next) => {
            res.header('Access-Control-Allow-Origin', '*');
            res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
            res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
            if (req.method === 'OPTIONS') {
                return res.sendStatus(200);
            }
            next();
        });

        this.app.use(express.json());
        // Serve static files from the React frontend app
        const frontendPath = path.join(__dirname, '../../frontend/dist');
        this.app.use(express.static(frontendPath));
    }

    private setupRoutes() {
        // API: Get status
        this.app.get('/api/status', (req, res) => {
            res.json({ status: 'ok', mode: this.config.mode });
        });

        // API: Get current config
        this.app.get('/api/config', (req, res) => {
            res.json(this.config);
        });

        // API: Update config
        this.app.post('/api/config', (req, res) => {
            try {
                const newConfig = saveConfig(req.body);
                this.config = newConfig;
                res.json({ success: true, config: newConfig, message: 'Config saved. Restart the server to apply changes.' });
            } catch (error) {
                res.status(400).json({ success: false, error: String(error) });
            }
        });

        // API: Validate WSJT-X path
        this.app.post('/api/validate-path', (req, res) => {
            const { path: wsjtxPath } = req.body;
            const exists = fs.existsSync(wsjtxPath);
            res.json({ valid: exists, path: wsjtxPath });
        });

        // API: Get instances
        this.app.get('/api/instances', (req, res) => {
            const instances = this.wsjtxManager.getInstances();
            res.json(instances);
        });

        // API: Start instance
        this.app.post('/api/instances/start', (req, res) => {
            try {
                const { name, band, rigName } = req.body;
                this.wsjtxManager.startInstance({ name: name || 'default', band, rigName });
                res.json({ success: true, message: `Started instance: ${name || 'default'}` });
            } catch (error) {
                res.status(400).json({ success: false, error: String(error) });
            }
        });

        // API: Stop instance
        this.app.post('/api/instances/stop', (req, res) => {
            const { name } = req.body;
            const success = this.wsjtxManager.stopInstance(name);
            res.json({ success, message: success ? `Stopped instance: ${name}` : `Instance not found: ${name}` });
        });

        // Handle React routing, return all requests to React app
        this.app.get('/{*splat}', (req, res) => {
            const frontendPath = path.join(__dirname, '../../frontend/dist');
            res.sendFile(path.join(frontendPath, 'index.html'));
        });
    }

    private setupWebSockets() {
        this.wss.on('connection', (ws: WebSocket) => {
            console.log('Web Client connected');

            // Send initial state
            ws.send(JSON.stringify({ type: 'WELCOME', message: 'Connected to WSJT-X MCP Server' }));

            // Send current slice states
            this.sendStationsUpdate(ws);

            ws.on('message', (message: string) => {
                console.log('Received:', message);
                try {
                    const data = JSON.parse(message.toString());
                    if (data.type === 'RELOAD_ADIF') {
                        this.wsjtxManager.reloadAdifLog();
                    }
                } catch (e) {
                    // Ignore invalid messages
                }
            });
        });

        // Listen for station updates from WsjtxManager
        this.wsjtxManager.on('stations-update', (slices: SliceState[]) => {
            this.broadcastStationsUpdate(slices);
        });
    }

    private sendStationsUpdate(ws: WebSocket): void {
        const message: StationsUpdateMessage = {
            type: 'STATIONS_UPDATE',
            slices: this.wsjtxManager.getSliceStates(),
            config: {
                stationLifetimeSeconds: this.config.dashboard.stationLifetimeSeconds,
                colors: this.config.dashboard.colors,
            },
        };
        ws.send(JSON.stringify(message));
    }

    private broadcastStationsUpdate(slices: SliceState[]): void {
        const message: StationsUpdateMessage = {
            type: 'STATIONS_UPDATE',
            slices,
            config: {
                stationLifetimeSeconds: this.config.dashboard.stationLifetimeSeconds,
                colors: this.config.dashboard.colors,
            },
        };
        const json = JSON.stringify(message);

        this.wss.clients.forEach((client) => {
            if (client.readyState === WebSocket.OPEN) {
                client.send(json);
            }
        });
    }

    public start() {
        const port = this.config.web.port;
        this.server.listen(port, () => {
            console.log(`Web Dashboard running at http://localhost:${port}`);
        });
    }
}
