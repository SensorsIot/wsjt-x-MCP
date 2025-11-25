import { useState, useEffect } from 'react';

interface Config {
  mode: 'FLEX' | 'STANDARD';
  wsjtx: {
    path: string;
  };
  station: {
    callsign: string;
    grid: string;
  };
  standard: {
    rigName: string;
  };
  flex: {
    host: string;
    catBasePort: number;
  };
}

interface SettingsProps {
  onBack: () => void;
  apiBase: string;
}

export function Settings({ onBack, apiBase }: SettingsProps) {
  const [config, setConfig] = useState<Config | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [pathValid, setPathValid] = useState<boolean | null>(null);

  useEffect(() => {
    fetchConfig();
  }, []);

  const fetchConfig = async () => {
    try {
      const res = await fetch(`${apiBase}/api/config`);
      const data = await res.json();
      setConfig(data);
      validatePath(data.wsjtx.path);
    } catch (error) {
      setMessage({ type: 'error', text: 'Failed to load config' });
    } finally {
      setLoading(false);
    }
  };

  const validatePath = async (path: string) => {
    try {
      const res = await fetch(`${apiBase}/api/validate-path`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path }),
      });
      const data = await res.json();
      setPathValid(data.valid);
    } catch {
      setPathValid(null);
    }
  };

  const handleSave = async () => {
    if (!config) return;
    setSaving(true);
    setMessage(null);

    try {
      const res = await fetch(`${apiBase}/api/config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config),
      });
      const data = await res.json();
      if (data.success) {
        setMessage({ type: 'success', text: data.message });
      } else {
        setMessage({ type: 'error', text: data.error });
      }
    } catch (error) {
      setMessage({ type: 'error', text: 'Failed to save config' });
    } finally {
      setSaving(false);
    }
  };

  const updateWsjtx = (field: keyof Config['wsjtx'], value: string) => {
    if (!config) return;
    setConfig({
      ...config,
      wsjtx: { ...config.wsjtx, [field]: value },
    });
    if (field === 'path') {
      validatePath(value);
    }
  };

  const updateStation = (field: keyof Config['station'], value: string) => {
    if (!config) return;
    setConfig({
      ...config,
      station: { ...config.station, [field]: value },
    });
  };

  const updateStandard = (field: keyof Config['standard'], value: string) => {
    if (!config) return;
    setConfig({
      ...config,
      standard: { ...config.standard, [field]: value },
    });
  };


  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-gray-400">Loading configuration...</div>
      </div>
    );
  }

  if (!config) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-red-400">Failed to load configuration</div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-bold text-white">Settings</h2>
        <button
          onClick={onBack}
          className="px-4 py-2 text-gray-400 hover:text-white transition-colors"
        >
          &larr; Back
        </button>
      </div>

      {/* Message */}
      {message && (
        <div
          className={`p-4 rounded-lg ${
            message.type === 'success'
              ? 'bg-green-900/50 border border-green-700 text-green-400'
              : 'bg-red-900/50 border border-red-700 text-red-400'
          }`}
        >
          {message.text}
        </div>
      )}

      {/* Operation Mode */}
      <section className="bg-gray-800/50 backdrop-blur-sm border border-gray-700 rounded-lg p-6">
        <h3 className="text-lg font-semibold text-blue-400 mb-4">Operation Mode</h3>
        <div className="flex gap-4">
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="radio"
              name="mode"
              value="STANDARD"
              checked={config.mode === 'STANDARD'}
              onChange={() => setConfig({ ...config, mode: 'STANDARD' })}
              className="w-4 h-4"
            />
            <span className="text-gray-300">Standard (Single Rig)</span>
          </label>
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="radio"
              name="mode"
              value="FLEX"
              checked={config.mode === 'FLEX'}
              onChange={() => setConfig({ ...config, mode: 'FLEX' })}
              className="w-4 h-4"
            />
            <span className="text-gray-300">FlexRadio (Multi-Slice)</span>
          </label>
        </div>
        <p className="text-sm text-gray-500 mt-2">
          {config.mode === 'STANDARD'
            ? 'Manual instance management with direct rig connection'
            : 'Automatic instance management based on SmartSDR slices'}
        </p>
      </section>

      {/* WSJT-X Path (Common) */}
      <section className="bg-gray-800/50 backdrop-blur-sm border border-gray-700 rounded-lg p-6">
        <h3 className="text-lg font-semibold text-blue-400 mb-4">WSJT-X Executable</h3>
        <div>
          <label className="block text-sm text-gray-400 mb-1">Path to wsjtx.exe</label>
          <div className="flex gap-2">
            <input
              type="text"
              value={config.wsjtx.path}
              onChange={(e) => updateWsjtx('path', e.target.value)}
              className="flex-1 bg-gray-900 border border-gray-600 rounded px-3 py-2 text-white focus:border-blue-500 focus:outline-none font-mono text-sm"
              placeholder="C:\WSJT\wsjtx\bin\wsjtx.exe"
            />
            <div className="flex items-center px-3 min-w-24">
              {pathValid === true && <span className="text-green-400 text-sm">Valid</span>}
              {pathValid === false && <span className="text-red-400 text-sm">Not found</span>}
              {pathValid === null && <span className="text-gray-500 text-sm">Checking...</span>}
            </div>
          </div>
        </div>
      </section>

      {/* Station Info (Common) */}
      <section className="bg-gray-800/50 backdrop-blur-sm border border-gray-700 rounded-lg p-6">
        <h3 className="text-lg font-semibold text-blue-400 mb-4">Station Information</h3>
        <p className="text-sm text-gray-500 mb-4">Used for autonomous QSO execution</p>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm text-gray-400 mb-1">Callsign</label>
            <input
              type="text"
              value={config.station.callsign}
              onChange={(e) => updateStation('callsign', e.target.value.toUpperCase())}
              className="w-full bg-gray-900 border border-gray-600 rounded px-3 py-2 text-white uppercase focus:border-blue-500 focus:outline-none"
              placeholder="W1ABC"
            />
          </div>
          <div>
            <label className="block text-sm text-gray-400 mb-1">Grid Locator</label>
            <input
              type="text"
              value={config.station.grid}
              onChange={(e) => updateStation('grid', e.target.value.toUpperCase())}
              className="w-full bg-gray-900 border border-gray-600 rounded px-3 py-2 text-white uppercase focus:border-blue-500 focus:outline-none"
              placeholder="FN31"
              maxLength={6}
            />
          </div>
        </div>
      </section>

      {/* Standard Mode Settings */}
      {config.mode === 'STANDARD' && (
        <section className="bg-gray-800/50 backdrop-blur-sm border border-gray-700 rounded-lg p-6">
          <h3 className="text-lg font-semibold text-blue-400 mb-4">Standard Mode Settings</h3>
          <div>
            <label className="block text-sm text-gray-400 mb-1">Rig Name</label>
            <input
              type="text"
              value={config.standard.rigName}
              onChange={(e) => updateStandard('rigName', e.target.value)}
              className="w-full max-w-xs bg-gray-900 border border-gray-600 rounded px-3 py-2 text-white focus:border-blue-500 focus:outline-none"
              placeholder="IC-7300"
            />
            <p className="text-sm text-gray-500 mt-1">
              Used as WSJT-X instance identifier (--rig-name parameter)
            </p>
          </div>
        </section>
      )}

      {/* Save Button */}
      <div className="flex justify-end gap-4">
        <button
          onClick={onBack}
          className="px-6 py-3 bg-gray-700 hover:bg-gray-600 text-white font-semibold rounded-lg transition-colors"
        >
          Cancel
        </button>
        <button
          onClick={handleSave}
          disabled={saving}
          className="px-6 py-3 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-600 text-white font-semibold rounded-lg transition-colors"
        >
          {saving ? 'Saving...' : 'Save Configuration'}
        </button>
      </div>

      {/* Help Text */}
      <div className="text-sm text-gray-500 text-center">
        Changes require a server restart to take effect.
      </div>
    </div>
  );
}
