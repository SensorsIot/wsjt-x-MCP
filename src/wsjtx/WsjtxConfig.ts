import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

/**
 * WSJT-X Configuration Manager
 * Handles pre-configuration of WSJT-X INI files before launch
 */

// WSJT-X uses ~1.46 Hz per bin for FT8 (sample rate 12000 / 8192 FFT bins)
const HZ_PER_BIN = 1.4648;

export interface WideGraphConfig {
    binsPerPixel?: number;      // 1-10, controls zoom level
    startFreq?: number;         // Start frequency offset in Hz
    plotZero?: number;          // Brightness offset
    plotGain?: number;          // Brightness gain
    hideControls?: boolean;     // Hide control panel on Wide Graph window
    plotWidth?: number;         // Width of waterfall plot in pixels (determines Hz range)
}

export interface RigConfig {
    smartCatHost?: string;      // SmartCAT host (usually 127.0.0.1)
    smartCatPort?: number;      // SmartCAT TCP port (7831 + sliceIndex, matching SliceMaster)
    daxChannel?: number;        // DAX audio channel (1-8)
}

// SmartCAT base port used by SliceMaster (7831 for slice A, 7832 for B, etc.)
export const SMARTCAT_BASE_PORT = 7831;

export interface WsjtxInstanceSettings {
    rigName: string;
    wideGraph?: WideGraphConfig;
    rig?: RigConfig;
}

/**
 * Get the WSJT-X config directory path
 */
export function getWsjtxConfigDir(): string {
    // Windows: %LOCALAPPDATA%\WSJT-X
    // Linux: ~/.config/WSJT-X
    // macOS: ~/Library/Preferences/WSJT-X
    if (process.platform === 'win32') {
        return path.join(os.homedir(), 'AppData', 'Local', 'WSJT-X');
    } else if (process.platform === 'darwin') {
        return path.join(os.homedir(), 'Library', 'Preferences', 'WSJT-X');
    } else {
        return path.join(os.homedir(), '.config', 'WSJT-X');
    }
}

/**
 * Get the INI file path for a specific WSJT-X instance
 */
export function getInstanceIniPath(rigName: string): string {
    const configDir = getWsjtxConfigDir();
    // Instance-specific config files are named "WSJT-X - <rigName>.ini"
    return path.join(configDir, `WSJT-X - ${rigName}.ini`);
}

/**
 * Calculate BinsPerPixel to show a target frequency range in a given window width
 * @param targetFreqHz Target frequency span in Hz
 * @param windowWidth Window width in pixels
 * @returns BinsPerPixel value (clamped to 1-10)
 */
export function calculateBinsPerPixel(targetFreqHz: number, windowWidth: number): number {
    // Hz per pixel needed
    const hzPerPixel = targetFreqHz / windowWidth;
    // Convert to bins per pixel
    const binsPerPixel = hzPerPixel / HZ_PER_BIN;
    // Clamp to valid range (1-10) and round to nearest integer
    return Math.max(1, Math.min(10, Math.round(binsPerPixel)));
}

/**
 * Calculate the window width needed to show a target frequency range with given BinsPerPixel
 * @param targetFreqHz Target frequency span in Hz
 * @param binsPerPixel BinsPerPixel setting
 * @returns Required window width in pixels
 */
export function calculateWindowWidth(targetFreqHz: number, binsPerPixel: number): number {
    const hzPerPixel = binsPerPixel * HZ_PER_BIN;
    return Math.ceil(targetFreqHz / hzPerPixel);
}

/**
 * Parse a simple INI file into sections
 */
function parseIni(content: string): Map<string, Map<string, string>> {
    const sections = new Map<string, Map<string, string>>();
    let currentSection = '';

    for (const line of content.split('\n')) {
        const trimmed = line.trim();

        // Skip empty lines and comments
        if (!trimmed || trimmed.startsWith(';') || trimmed.startsWith('#')) {
            continue;
        }

        // Section header
        const sectionMatch = trimmed.match(/^\[([^\]]+)\]$/);
        if (sectionMatch) {
            currentSection = sectionMatch[1];
            if (!sections.has(currentSection)) {
                sections.set(currentSection, new Map());
            }
            continue;
        }

        // Key=value pair
        const kvMatch = trimmed.match(/^([^=]+)=(.*)$/);
        if (kvMatch && currentSection) {
            const key = kvMatch[1].trim();
            const value = kvMatch[2];
            sections.get(currentSection)!.set(key, value);
        }
    }

    return sections;
}

/**
 * Serialize sections back to INI format
 */
function serializeIni(sections: Map<string, Map<string, string>>): string {
    const lines: string[] = [];

    for (const [sectionName, sectionData] of sections) {
        lines.push(`[${sectionName}]`);
        for (const [key, value] of sectionData) {
            lines.push(`${key}=${value}`);
        }
        lines.push('');
    }

    return lines.join('\n');
}

/**
 * Configure Wide Graph settings in the INI file
 * This should be called BEFORE launching WSJT-X
 */
export function configureWideGraph(
    rigName: string,
    config: WideGraphConfig
): boolean {
    const iniPath = getInstanceIniPath(rigName);
    const configDir = getWsjtxConfigDir();

    console.log(`Configuring Wide Graph for ${rigName}:`);
    console.log(`  INI path: ${iniPath}`);

    // Ensure config directory exists
    if (!fs.existsSync(configDir)) {
        fs.mkdirSync(configDir, { recursive: true });
    }

    let sections: Map<string, Map<string, string>>;

    // Read existing config, or use our template for new instances
    if (fs.existsSync(iniPath)) {
        const content = fs.readFileSync(iniPath, 'utf-8');
        sections = parseIni(content);
    } else {
        // First try our custom template (has correct settings)
        const templatePath = path.join(__dirname, '..', '..', 'templates', 'wsjtx-template.ini');
        if (fs.existsSync(templatePath)) {
            console.log(`  Using custom template from ${templatePath}`);
            const content = fs.readFileSync(templatePath, 'utf-8');
            sections = parseIni(content);
        } else {
            // Fall back to default WSJT-X.ini (not ideal, has wrong settings)
            const defaultIniPath = path.join(configDir, 'WSJT-X.ini');
            if (fs.existsSync(defaultIniPath)) {
                console.log(`  Copying base config from WSJT-X.ini (warning: may have incorrect settings)`);
                const content = fs.readFileSync(defaultIniPath, 'utf-8');
                sections = parseIni(content);
            } else {
                console.log(`  Creating minimal config (no template found)`);
                sections = new Map();
            }
        }
    }

    // Ensure WideGraph section exists
    if (!sections.has('WideGraph')) {
        sections.set('WideGraph', new Map());
    }

    const wideGraph = sections.get('WideGraph')!;

    // Apply settings
    if (config.binsPerPixel !== undefined) {
        wideGraph.set('BinsPerPixel', config.binsPerPixel.toString());
        console.log(`  BinsPerPixel: ${config.binsPerPixel}`);
    }

    if (config.startFreq !== undefined) {
        wideGraph.set('StartFreq', config.startFreq.toString());
        console.log(`  StartFreq: ${config.startFreq}`);
    }

    if (config.plotZero !== undefined) {
        wideGraph.set('PlotZero', config.plotZero.toString());
    }

    if (config.plotGain !== undefined) {
        wideGraph.set('PlotGain', config.plotGain.toString());
    }

    if (config.plotWidth !== undefined) {
        wideGraph.set('PlotWidth', config.plotWidth.toString());
        console.log(`  PlotWidth: ${config.plotWidth}`);
    }

    // HideControls must be in [Configuration] section, NOT [WideGraph]
    if (config.hideControls !== undefined) {
        // Ensure Configuration section exists
        if (!sections.has('Configuration')) {
            sections.set('Configuration', new Map());
        }
        const configSection = sections.get('Configuration')!;
        configSection.set('HideControls', config.hideControls ? 'true' : 'false');
        console.log(`  HideControls: ${config.hideControls} (in [Configuration] section)`);

        // Remove HideControls from WideGraph section if it exists (wrong location)
        if (wideGraph.has('HideControls')) {
            wideGraph.delete('HideControls');
            console.log(`  Removed HideControls from [WideGraph] section (incorrect location)`);
        }
    }

    // Always remove cached geometry from WideGraph to force WSJT-X to respect settings
    if (wideGraph.has('geometry')) {
        wideGraph.delete('geometry');
        console.log(`  Removed WideGraph geometry cache`);
    }

    // Remove MainWindow geometry caches that can affect Wide Graph
    if (sections.has('MainWindow')) {
        const mainWindow = sections.get('MainWindow')!;
        if (mainWindow.has('geometry')) {
            mainWindow.delete('geometry');
            console.log(`  Removed MainWindow geometry cache`);
        }
        if (mainWindow.has('geometryNoControls')) {
            mainWindow.delete('geometryNoControls');
            console.log(`  Removed MainWindow geometryNoControls cache`);
        }
    }

    // Write back
    try {
        const content = serializeIni(sections);
        fs.writeFileSync(iniPath, content, 'utf-8');
        console.log(`  Configuration saved successfully`);
        return true;
    } catch (error) {
        console.error(`  Failed to write config:`, error);
        return false;
    }
}

/**
 * Configure WSJT-X instance for optimal 2500 Hz waterfall display
 * @param rigName The rig name for the instance
 * @param windowWidth The Wide Graph window width in pixels
 */
export function configureFor2500Hz(rigName: string, windowWidth: number): void {
    // Calculate BinsPerPixel for 2500 Hz in the given window width
    const binsPerPixel = calculateBinsPerPixel(2500, windowWidth);

    // Calculate actual frequency range that will be displayed
    const actualFreqRange = windowWidth * binsPerPixel * HZ_PER_BIN;

    console.log(`  Target: 2500 Hz in ${windowWidth}px window`);
    console.log(`  Calculated BinsPerPixel: ${binsPerPixel}`);
    console.log(`  Actual frequency range: ~${Math.round(actualFreqRange)} Hz`);

    configureWideGraph(rigName, {
        binsPerPixel: binsPerPixel,
        startFreq: 0,
    });
}

/**
 * Configure Rig/Radio settings for SmartCAT (FlexRadio)
 * This configures WSJT-X to use "Ham Radio Deluxe" rig type to connect to SmartCAT
 * Configuration matches SliceMaster's proven working settings
 */
export function configureRigForSmartCat(
    rigName: string,
    config: RigConfig
): boolean {
    const iniPath = getInstanceIniPath(rigName);
    const configDir = getWsjtxConfigDir();

    const smartCatHost = config.smartCatHost || '127.0.0.1';
    const smartCatPort = config.smartCatPort || SMARTCAT_BASE_PORT;
    const daxChannel = config.daxChannel || 1;

    console.log(`Configuring Rig for SmartCAT (${rigName}):`);
    console.log(`  INI path: ${iniPath}`);
    console.log(`  SmartCAT: ${smartCatHost}:${smartCatPort}`);
    console.log(`  DAX Channel: ${daxChannel}`);

    // Ensure config directory exists
    if (!fs.existsSync(configDir)) {
        fs.mkdirSync(configDir, { recursive: true });
    }

    let sections: Map<string, Map<string, string>>;

    // Read existing config or create new
    if (fs.existsSync(iniPath)) {
        const content = fs.readFileSync(iniPath, 'utf-8');
        sections = parseIni(content);
    } else {
        sections = new Map();
    }

    // Ensure Configuration section exists
    if (!sections.has('Configuration')) {
        sections.set('Configuration', new Map());
    }

    const configSection = sections.get('Configuration')!;

    // Use "Ham Radio Deluxe" rig type (matches SliceMaster's working config)
    configSection.set('Rig', 'Ham Radio Deluxe');

    // CATNetworkPort uses combined "host:port" format (SliceMaster convention)
    configSection.set('CATNetworkPort', `${smartCatHost}:${smartCatPort}`);

    // PTT method - CAT (matches SliceMaster)
    configSection.set('PTTMethod', '@Variant(\\0\\0\\0\\x7f\\0\\0\\0\\x1eTransceiverFactory::PTTMethod\\0\\0\\0\\0\\xfPTT_method_CAT\\0)');

    // Split operation mode - None
    configSection.set('SplitMode', '@Variant(\\0\\0\\0\\x7f\\0\\0\\0\\x1eTransceiverFactory::SplitMode\\0\\0\\0\\0\\x10split_mode_none\\0)');

    // Audio settings - DAX channel (matches SliceMaster format with full device name)
    const daxRx = `DAX Audio RX ${daxChannel} (FlexRadio Systems DAX Audio)`;
    const daxTx = `DAX Audio TX (FlexRadio Systems DAX TX)`;  // All slices share same TX device
    configSection.set('SoundInName', daxRx);
    configSection.set('SoundOutName', daxTx);
    configSection.set('AudioInputChannel', 'Mono');
    configSection.set('AudioOutputChannel', 'Mono');

    // Set reasonable defaults matching SliceMaster
    configSection.set('RxBandwidth', '4500');
    configSection.set('Polling', '1');

    console.log(`  Rig: Ham Radio Deluxe`);
    console.log(`  CATNetworkPort: ${smartCatHost}:${smartCatPort}`);
    console.log(`  Audio In: ${daxRx}`);
    console.log(`  Audio Out: ${daxTx}`);

    // Write back
    try {
        const content = serializeIni(sections);
        fs.writeFileSync(iniPath, content, 'utf-8');
        console.log(`  Rig configuration saved successfully`);
        return true;
    } catch (error) {
        console.error(`  Failed to write rig config:`, error);
        return false;
    }
}
