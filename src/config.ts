import { z } from 'zod';
import fs from 'fs';
import path from 'path';

export const OperationModeSchema = z.enum(['FLEX', 'STANDARD']);
export type OperationMode = z.infer<typeof OperationModeSchema>;

// Station status priority (higher = more important, used for hierarchical coloring)
export const StationStatusSchema = z.enum([
    'worked',      // Already in log (lowest priority - gray)
    'normal',      // Normal station (default)
    'weak',        // Weak signal (below threshold)
    'strong',      // Strong signal (above threshold)
    'priority',    // Contest priority (placeholder for future)
    'new_dxcc',    // New DXCC (placeholder for future)
]);
export type StationStatus = z.infer<typeof StationStatusSchema>;

export const ConfigSchema = z.object({
    // Common parameters
    mode: OperationModeSchema.default('STANDARD'),
    wsjtx: z.object({
        path: z.string().default('C:\\WSJT\\wsjtx\\bin\\wsjtx.exe'),
    }),
    station: z.object({
        callsign: z.string().default(''),
        grid: z.string().default(''),
    }),
    // Standard mode parameters
    standard: z.object({
        rigName: z.string().default('IC-7300'),
    }),
    // FlexRadio mode parameters
    flex: z.object({
        host: z.string().default('127.0.0.1'),
        catBasePort: z.number().default(60000), // SmartCAT TCP port (increments per slice)
        // Default FT8 dial frequencies for each slice (in Hz)
        // Slice A=index 0, B=index 1, etc.
        defaultBands: z.array(z.number()).optional(), // e.g., [28074000, 21074000, 14074000, 7074000]
    }),
    // Dashboard station tracking settings
    dashboard: z.object({
        stationLifetimeSeconds: z.number().default(120), // How long to show stations after last decode
        snrWeakThreshold: z.number().default(-15),       // SNR below this = weak
        snrStrongThreshold: z.number().default(0),       // SNR above this = strong
        adifLogPath: z.string().default(''),             // Path to combined ADIF log file
        colors: z.object({
            worked: z.string().default('#6b7280'),       // gray-500
            normal: z.string().default('#3b82f6'),       // blue-500
            weak: z.string().default('#eab308'),         // yellow-500
            strong: z.string().default('#22c55e'),       // green-500
            priority: z.string().default('#f97316'),     // orange-500
            new_dxcc: z.string().default('#ec4899'),     // pink-500
        }).optional(),
    }).optional(),
    // Internal parameters (not user-configurable)
    mcp: z.object({
        name: z.string().default('wsjt-x-mcp'),
        version: z.string().default('1.0.0'),
    }),
    web: z.object({
        port: z.number().default(3000),
    })
});

export type Config = z.infer<typeof ConfigSchema>;

const CONFIG_FILE = path.join(process.cwd(), 'config.json');

export function loadConfig(): Config {
    let fileConfig = {};

    // Try to load from config file
    if (fs.existsSync(CONFIG_FILE)) {
        try {
            const fileContent = fs.readFileSync(CONFIG_FILE, 'utf-8');
            fileConfig = JSON.parse(fileContent);
            console.log('Loaded config from config.json');
        } catch (error) {
            console.error('Error loading config.json:', error);
        }
    }

    // Merge with env vars (env vars take precedence)
    const mode = process.env.WSJTX_MODE?.toUpperCase() === 'FLEX' ? 'FLEX' :
                 (fileConfig as any)?.mode || 'STANDARD';

    return ConfigSchema.parse({
        ...fileConfig,
        mode,
        flex: {
            ...((fileConfig as any)?.flex || {}),
            host: process.env.FLEX_HOST || (fileConfig as any)?.flex?.host,
        },
        standard: {
            ...((fileConfig as any)?.standard || {}),
            rigName: process.env.RIG_NAME || (fileConfig as any)?.standard?.rigName,
            rigPort: process.env.RIG_PORT || (fileConfig as any)?.standard?.rigPort,
        },
        wsjtx: (fileConfig as any)?.wsjtx || {},
        station: (fileConfig as any)?.station || {},
        dashboard: (fileConfig as any)?.dashboard || {},
        mcp: (fileConfig as any)?.mcp || {},
        web: (fileConfig as any)?.web || {}
    });
}

export function saveConfig(config: Partial<Config>): Config {
    let existingConfig = {};

    if (fs.existsSync(CONFIG_FILE)) {
        try {
            existingConfig = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
        } catch (error) {
            // Ignore
        }
    }

    const mergedConfig = { ...existingConfig, ...config };
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(mergedConfig, null, 2));
    console.log('Config saved to config.json');

    return ConfigSchema.parse(mergedConfig);
}

export function getConfigFilePath(): string {
    return CONFIG_FILE;
}
