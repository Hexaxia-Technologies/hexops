'use client';

import { useState, useEffect, useCallback } from 'react';
import { toast } from 'sonner';
import { ChevronDown, ChevronRight, FolderOpen, GitBranch, Cloud, Eye, EyeOff, Check, X, Loader2, Save } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { GlobalSettings } from '@/lib/types';

// Collapsible section wrapper
interface CollapsibleSectionProps {
  title: string;
  icon: React.ReactNode;
  defaultOpen?: boolean;
  isDirty?: boolean;
  children: React.ReactNode;
}

function CollapsibleSection({ title, icon, defaultOpen = false, isDirty, children }: CollapsibleSectionProps) {
  const [isOpen, setIsOpen] = useState(defaultOpen);

  return (
    <div className="border border-zinc-800 rounded-lg overflow-hidden">
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="w-full flex items-center justify-between px-4 py-3 bg-zinc-900/50 hover:bg-zinc-900 transition-colors"
      >
        <div className="flex items-center gap-2">
          {icon}
          <span className="text-sm font-medium text-zinc-200">{title}</span>
          {isDirty && (
            <span className="w-2 h-2 rounded-full bg-yellow-500" title="Unsaved changes" />
          )}
        </div>
        {isOpen ? (
          <ChevronDown className="h-4 w-4 text-zinc-500" />
        ) : (
          <ChevronRight className="h-4 w-4 text-zinc-500" />
        )}
      </button>
      {isOpen && (
        <div className="p-4 border-t border-zinc-800 bg-zinc-950">
          {children}
        </div>
      )}
    </div>
  );
}

// Input field component
interface FieldProps {
  label: string;
  description?: string;
  value: string;
  onChange: (value: string) => void;
  type?: 'text' | 'password';
  placeholder?: string;
}

function Field({ label, description, value, onChange, type = 'text', placeholder }: FieldProps) {
  const [showPassword, setShowPassword] = useState(false);
  const inputType = type === 'password' && !showPassword ? 'password' : 'text';

  return (
    <div className="space-y-1">
      <label className="text-sm font-medium text-zinc-300">{label}</label>
      {description && <p className="text-xs text-zinc-500">{description}</p>}
      <div className="relative">
        <input
          type={inputType}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          className="w-full px-3 py-2 bg-zinc-900 border border-zinc-700 rounded-md text-sm text-zinc-100 placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-purple-500/50 focus:border-purple-500"
        />
        {type === 'password' && (
          <button
            type="button"
            onClick={() => setShowPassword(!showPassword)}
            className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-zinc-500 hover:text-zinc-300"
          >
            {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
          </button>
        )}
      </div>
    </div>
  );
}

// Toggle switch component
interface ToggleProps {
  label: string;
  description?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}

function Toggle({ label, description, checked, onChange }: ToggleProps) {
  return (
    <div className="flex items-center justify-between">
      <div>
        <label className="text-sm font-medium text-zinc-300">{label}</label>
        {description && <p className="text-xs text-zinc-500">{description}</p>}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
          checked ? 'bg-purple-600' : 'bg-zinc-700'
        }`}
      >
        <span
          className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
            checked ? 'translate-x-6' : 'translate-x-1'
          }`}
        />
      </button>
    </div>
  );
}

export default function SettingsPage() {
  const [settings, setSettings] = useState<GlobalSettings | null>(null);
  const [originalSettings, setOriginalSettings] = useState<GlobalSettings | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [vercelStatus, setVercelStatus] = useState<'idle' | 'checking' | 'valid' | 'invalid'>('idle');
  const [vercelUser, setVercelUser] = useState<string | null>(null);

  // Check if settings have changed
  const isDirty = settings && originalSettings
    ? JSON.stringify(settings) !== JSON.stringify(originalSettings)
    : false;

  // Fetch settings
  const fetchSettings = useCallback(async () => {
    try {
      const res = await fetch('/api/settings');
      const data = await res.json();
      setSettings(data);
      // Deep clone for original to avoid reference issues
      setOriginalSettings(JSON.parse(JSON.stringify(data)));
    } catch (error) {
      console.error('Failed to fetch settings:', error);
      toast.error('Failed to load settings');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchSettings();
  }, [fetchSettings]);

  // Save all settings
  const handleSave = async () => {
    if (!settings || !isDirty) return;

    setIsSaving(true);
    try {
      const res = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(settings),
      });

      if (res.ok) {
        const updated = await res.json();
        setSettings(updated);
        // Deep clone for original to avoid reference issues
        setOriginalSettings(JSON.parse(JSON.stringify(updated)));
        toast.success('Settings saved');
      } else {
        toast.error('Failed to save settings');
      }
    } catch (error) {
      console.error('Failed to save settings:', error);
      toast.error('Failed to save settings');
    } finally {
      setIsSaving(false);
    }
  };

  // Discard changes
  const handleDiscard = () => {
    if (originalSettings) {
      // Deep clone to avoid reference issues
      setSettings(JSON.parse(JSON.stringify(originalSettings)));
      toast.info('Changes discarded');
    }
  };

  // Verify Vercel token
  const verifyVercel = async () => {
    if (!settings?.integrations.vercel.token) {
      setVercelStatus('idle');
      setVercelUser(null);
      return;
    }

    setVercelStatus('checking');
    try {
      const res = await fetch('/api/settings/verify-vercel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token: settings.integrations.vercel.token,
          teamId: settings.integrations.vercel.teamId || undefined,
        }),
      });

      const data = await res.json();
      if (data.valid) {
        setVercelStatus('valid');
        setVercelUser(data.user);
      } else {
        setVercelStatus('invalid');
        setVercelUser(null);
      }
    } catch (error) {
      console.error('Failed to verify Vercel token:', error);
      setVercelStatus('invalid');
      setVercelUser(null);
    }
  };

  // Update local state helpers
  const updatePaths = (key: keyof GlobalSettings['paths'], value: string) => {
    if (!settings) return;
    setSettings({
      ...settings,
      paths: { ...settings.paths, [key]: value },
    });
  };

  const updateGit = (key: keyof GlobalSettings['integrations']['git'], value: string | boolean) => {
    if (!settings) return;
    setSettings({
      ...settings,
      integrations: {
        ...settings.integrations,
        git: { ...settings.integrations.git, [key]: value },
      },
    });
  };

  const updateVercel = (key: keyof GlobalSettings['integrations']['vercel'], value: string | null) => {
    if (!settings) return;
    setSettings({
      ...settings,
      integrations: {
        ...settings.integrations,
        vercel: { ...settings.integrations.vercel, [key]: value },
      },
    });
    // Reset verification status when token changes
    if (key === 'token' || key === 'teamId') {
      setVercelStatus('idle');
      setVercelUser(null);
    }
  };

  if (isLoading || !settings) {
    return (
      <main className="flex-1 flex items-center justify-center">
        <div className="text-zinc-500">Loading settings...</div>
      </main>
    );
  }

  return (
    <main className="flex-1 flex flex-col overflow-hidden">
      <header className="border-b border-zinc-800 px-6 py-4">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-semibold text-zinc-100">Settings</h1>
            <p className="text-xs text-zinc-500 mt-1">
              Global configuration for HexOps
            </p>
          </div>
          <div className="flex items-center gap-2">
            {isDirty && (
              <>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={handleDiscard}
                  className="text-xs text-zinc-400 hover:text-zinc-200"
                >
                  Discard
                </Button>
                <Button
                  size="sm"
                  onClick={handleSave}
                  disabled={isSaving}
                  className="text-xs bg-purple-600 hover:bg-purple-500"
                >
                  {isSaving ? (
                    <>
                      <Loader2 className="h-3 w-3 animate-spin mr-1" />
                      Saving...
                    </>
                  ) : (
                    <>
                      <Save className="h-3 w-3 mr-1" />
                      Save Changes
                    </>
                  )}
                </Button>
              </>
            )}
          </div>
        </div>
      </header>

      <div className="flex-1 overflow-auto p-6 space-y-4">
        {/* System Paths */}
        <CollapsibleSection
          title="System Paths"
          icon={<FolderOpen className="h-4 w-4 text-zinc-500" />}
          defaultOpen
        >
          <div className="space-y-4">
            <Field
              label="Projects Root"
              description="Default directory for the shell and scanning projects"
              value={settings.paths.projectsRoot}
              onChange={(v) => updatePaths('projectsRoot', v)}
              placeholder="/home/user/Projects"
            />
            <Field
              label="Logs Directory"
              description="Where system logs are stored (relative to HexOps root)"
              value={settings.paths.logsDir}
              onChange={(v) => updatePaths('logsDir', v)}
              placeholder=".hexops/logs"
            />
            <Field
              label="Cache Directory"
              description="Where cache files are stored (relative to HexOps root)"
              value={settings.paths.cacheDir}
              onChange={(v) => updatePaths('cacheDir', v)}
              placeholder=".hexops/cache"
            />
          </div>
        </CollapsibleSection>

        {/* Git Defaults */}
        <CollapsibleSection
          title="Git Defaults"
          icon={<GitBranch className="h-4 w-4 text-zinc-500" />}
          defaultOpen
        >
          <div className="space-y-4">
            <Field
              label="Default Branch"
              description="Default branch name for new repositories"
              value={settings.integrations.git.defaultBranch}
              onChange={(v) => updateGit('defaultBranch', v)}
              placeholder="main"
            />
            <Field
              label="Commit Prefix"
              description="Prefix added to all commit messages (e.g., 'chore: ')"
              value={settings.integrations.git.commitPrefix}
              onChange={(v) => updateGit('commitPrefix', v)}
              placeholder="chore: "
            />
            <Toggle
              label="Auto-push after commit"
              description="Automatically push to remote after committing"
              checked={settings.integrations.git.pushAfterCommit}
              onChange={(v) => updateGit('pushAfterCommit', v)}
            />
          </div>
        </CollapsibleSection>

        {/* Vercel Integration */}
        <CollapsibleSection
          title="Vercel Integration"
          icon={<Cloud className="h-4 w-4 text-zinc-500" />}
          defaultOpen
        >
          <div className="space-y-4">
            <Field
              label="API Token"
              description="Vercel API token for deployments and project info"
              value={settings.integrations.vercel.token || ''}
              onChange={(v) => updateVercel('token', v || null)}
              type="password"
              placeholder="Enter your Vercel API token"
            />
            <Field
              label="Team ID"
              description="Optional team ID (leave empty for personal account)"
              value={settings.integrations.vercel.teamId || ''}
              onChange={(v) => updateVercel('teamId', v || null)}
              placeholder="team_xxx (optional)"
            />

            {/* Connection Status */}
            <div className="flex items-center justify-between pt-2 border-t border-zinc-800">
              <div className="flex items-center gap-2">
                <span className="text-sm text-zinc-400">Connection Status:</span>
                {vercelStatus === 'idle' && (
                  <span className="text-xs text-zinc-500">Not verified</span>
                )}
                {vercelStatus === 'checking' && (
                  <span className="flex items-center gap-1 text-xs text-yellow-500">
                    <Loader2 className="h-3 w-3 animate-spin" />
                    Checking...
                  </span>
                )}
                {vercelStatus === 'valid' && (
                  <span className="flex items-center gap-1 text-xs text-green-500">
                    <Check className="h-3 w-3" />
                    Connected{vercelUser ? ` as ${vercelUser}` : ''}
                  </span>
                )}
                {vercelStatus === 'invalid' && (
                  <span className="flex items-center gap-1 text-xs text-red-500">
                    <X className="h-3 w-3" />
                    Invalid token or team ID
                  </span>
                )}
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={verifyVercel}
                disabled={!settings.integrations.vercel.token || vercelStatus === 'checking'}
                className="text-xs"
              >
                Verify Connection
              </Button>
            </div>
          </div>
        </CollapsibleSection>
      </div>
    </main>
  );
}
