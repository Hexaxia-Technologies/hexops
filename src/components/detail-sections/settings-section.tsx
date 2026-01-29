'use client';

import { useState, useEffect, useCallback } from 'react';
import { toast } from 'sonner';
import { Plus, Trash2, Loader2, Save } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { ProjectSettings } from '@/lib/types';

interface SettingsSectionProps {
  projectId: string;
}

// Input field component
interface FieldProps {
  label: string;
  description?: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  type?: 'text' | 'number';
}

function Field({ label, description, value, onChange, placeholder, type = 'text' }: FieldProps) {
  return (
    <div className="space-y-1">
      <label className="text-xs font-medium text-zinc-400">{label}</label>
      {description && <p className="text-xs text-zinc-600">{description}</p>}
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full px-2 py-1.5 bg-zinc-900 border border-zinc-700 rounded text-xs text-zinc-100 placeholder-zinc-600 focus:outline-none focus:ring-1 focus:ring-purple-500/50 focus:border-purple-500"
      />
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
        <label className="text-xs font-medium text-zinc-400">{label}</label>
        {description && <p className="text-xs text-zinc-600">{description}</p>}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
          checked ? 'bg-purple-600' : 'bg-zinc-700'
        }`}
      >
        <span
          className={`inline-block h-3 w-3 transform rounded-full bg-white transition-transform ${
            checked ? 'translate-x-5' : 'translate-x-1'
          }`}
        />
      </button>
    </div>
  );
}

// Select dropdown component
interface SelectProps {
  label: string;
  description?: string;
  value: string;
  onChange: (value: string) => void;
  options: { value: string; label: string }[];
}

function Select({ label, description, value, onChange, options }: SelectProps) {
  return (
    <div className="space-y-1">
      <label className="text-xs font-medium text-zinc-400">{label}</label>
      {description && <p className="text-xs text-zinc-600">{description}</p>}
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full px-2 py-1.5 bg-zinc-900 border border-zinc-700 rounded text-xs text-zinc-100 focus:outline-none focus:ring-1 focus:ring-purple-500/50 focus:border-purple-500"
      >
        {options.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
    </div>
  );
}

// Subsection header
function SubsectionHeader({ title }: { title: string }) {
  return (
    <h4 className="text-xs font-semibold text-zinc-300 uppercase tracking-wide mb-3 mt-4 first:mt-0">
      {title}
    </h4>
  );
}

export function SettingsSection({ projectId }: SettingsSectionProps) {
  const [settings, setSettings] = useState<ProjectSettings | null>(null);
  const [originalSettings, setOriginalSettings] = useState<ProjectSettings | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [envEntries, setEnvEntries] = useState<[string, string][]>([]);
  const [originalEnvEntries, setOriginalEnvEntries] = useState<[string, string][]>([]);

  // Check if settings have changed
  const isDirty = (settings && originalSettings
    ? JSON.stringify(settings) !== JSON.stringify(originalSettings)
    : false) || JSON.stringify(envEntries) !== JSON.stringify(originalEnvEntries);

  // Fetch settings
  const fetchSettings = useCallback(async () => {
    try {
      const res = await fetch(`/api/projects/${projectId}/settings`);
      const data = await res.json();
      setSettings(data);
      // Deep clone for original to avoid reference issues
      setOriginalSettings(JSON.parse(JSON.stringify(data)));
      const entries = Object.entries(data.env || {}) as [string, string][];
      setEnvEntries(entries);
      setOriginalEnvEntries(JSON.parse(JSON.stringify(entries)));
    } catch (error) {
      console.error('Failed to fetch project settings:', error);
      toast.error('Failed to load project settings');
    } finally {
      setIsLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    fetchSettings();
  }, [fetchSettings]);

  // Save settings
  const handleSave = async () => {
    if (!settings || !isDirty) return;

    setIsSaving(true);
    try {
      // Build env from entries
      const env = Object.fromEntries(envEntries.filter(([k]) => k.trim()));

      const res = await fetch(`/api/projects/${projectId}/settings`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...settings, env }),
      });

      if (res.ok) {
        const updated = await res.json();
        setSettings(updated);
        // Deep clone for original to avoid reference issues
        setOriginalSettings(JSON.parse(JSON.stringify(updated)));
        const entries = Object.entries(updated.env || {}) as [string, string][];
        setEnvEntries(entries);
        setOriginalEnvEntries(JSON.parse(JSON.stringify(entries)));
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
      setEnvEntries(JSON.parse(JSON.stringify(originalEnvEntries)));
      toast.info('Changes discarded');
    }
  };

  // Update local state helpers
  const updateSetting = <K extends keyof ProjectSettings>(
    key: K,
    value: ProjectSettings[K]
  ) => {
    if (!settings) return;
    setSettings({ ...settings, [key]: value });
  };

  const updateNestedSetting = <
    K extends keyof ProjectSettings,
    NK extends keyof NonNullable<ProjectSettings[K]>
  >(
    key: K,
    nestedKey: NK,
    value: NonNullable<ProjectSettings[K]>[NK]
  ) => {
    if (!settings) return;
    const current = settings[key] as Record<string, unknown>;
    setSettings({
      ...settings,
      [key]: { ...current, [nestedKey]: value },
    });
  };

  // Environment variable handlers
  const addEnvVar = () => {
    setEnvEntries([...envEntries, ['', '']]);
  };

  const updateEnvVar = (index: number, key: string, value: string) => {
    const newEntries = [...envEntries];
    newEntries[index] = [key, value];
    setEnvEntries(newEntries);
  };

  const removeEnvVar = (index: number) => {
    const newEntries = envEntries.filter((_, i) => i !== index);
    setEnvEntries(newEntries);
  };

  if (isLoading || !settings) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 className="h-4 w-4 animate-spin text-zinc-500" />
        <span className="ml-2 text-xs text-zinc-500">Loading settings...</span>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Save/Discard buttons */}
      {isDirty && (
        <div className="flex items-center justify-end gap-2 pb-2 border-b border-zinc-800">
          <Button
            variant="ghost"
            size="sm"
            onClick={handleDiscard}
            className="text-xs text-zinc-400 hover:text-zinc-200 h-7"
          >
            Discard
          </Button>
          <Button
            size="sm"
            onClick={handleSave}
            disabled={isSaving}
            className="text-xs bg-purple-600 hover:bg-purple-500 h-7"
          >
            {isSaving ? (
              <>
                <Loader2 className="h-3 w-3 animate-spin mr-1" />
                Saving...
              </>
            ) : (
              <>
                <Save className="h-3 w-3 mr-1" />
                Save
              </>
            )}
          </Button>
        </div>
      )}

      {/* Environment */}
      <SubsectionHeader title="Environment" />
      <div className="space-y-3">
        <div className="space-y-2">
          <label className="text-xs font-medium text-zinc-400">Environment Variables</label>
          {envEntries.map(([key, value], index) => (
            <div key={index} className="flex gap-2">
              <input
                type="text"
                value={key}
                onChange={(e) => updateEnvVar(index, e.target.value, value)}
                placeholder="KEY"
                className="flex-1 px-2 py-1.5 bg-zinc-900 border border-zinc-700 rounded text-xs text-zinc-100 placeholder-zinc-600 font-mono"
              />
              <input
                type="text"
                value={value}
                onChange={(e) => updateEnvVar(index, key, e.target.value)}
                placeholder="value"
                className="flex-1 px-2 py-1.5 bg-zinc-900 border border-zinc-700 rounded text-xs text-zinc-100 placeholder-zinc-600 font-mono"
              />
              <button
                onClick={() => removeEnvVar(index)}
                className="p-1.5 text-zinc-500 hover:text-red-400 transition-colors"
              >
                <Trash2 className="h-3 w-3" />
              </button>
            </div>
          ))}
          <button
            onClick={addEnvVar}
            className="flex items-center gap-1 text-xs text-purple-400 hover:text-purple-300"
          >
            <Plus className="h-3 w-3" />
            Add Variable
          </button>
        </div>

        <Field
          label="Node Version"
          description="Override system Node.js version (e.g., 20.x)"
          value={settings.nodeVersion || ''}
          onChange={(v) => updateSetting('nodeVersion', v || null)}
          placeholder="System default"
        />

        <Select
          label="Shell"
          description="Shell used for running scripts"
          value={settings.shell || 'system'}
          onChange={(v) => {
            const shell = v === 'system' ? null : (v as 'bash' | 'zsh');
            updateSetting('shell', shell);
          }}
          options={[
            { value: 'system', label: 'System Default' },
            { value: 'bash', label: 'Bash' },
            { value: 'zsh', label: 'Zsh' },
          ]}
        />
      </div>

      {/* Git Behavior */}
      <SubsectionHeader title="Git Behavior" />
      <div className="space-y-3">
        <Toggle
          label="Auto-pull on start"
          description="Pull latest changes before starting dev server"
          checked={settings.git.autoPull}
          onChange={(v) => updateNestedSetting('git', 'autoPull', v)}
        />

        <Field
          label="Commit Template"
          description="Template for commit messages (supports {project}, {date})"
          value={settings.git.commitTemplate || ''}
          onChange={(v) => updateNestedSetting('git', 'commitTemplate', v || null)}
          placeholder="Default template"
        />

        <Field
          label="Preferred Branch"
          description="Override default branch for this project"
          value={settings.git.branch || ''}
          onChange={(v) => updateNestedSetting('git', 'branch', v || null)}
          placeholder="Use global default"
        />
      </div>

      {/* Deploy */}
      <SubsectionHeader title="Deploy" />
      <div className="space-y-3">
        <Field
          label="Vercel Project ID"
          description="Project ID from .vercel/project.json"
          value={settings.deploy.vercelProjectId || ''}
          onChange={(v) => updateNestedSetting('deploy', 'vercelProjectId', v || null)}
          placeholder="prj_xxx"
        />

        <Field
          label="Auto-deploy Branch"
          description="Automatically deploy when pushing to this branch"
          value={settings.deploy.autoDeployBranch || ''}
          onChange={(v) => updateNestedSetting('deploy', 'autoDeployBranch', v || null)}
          placeholder="Disabled"
        />

        <Select
          label="Default Environment"
          description="Default deployment environment"
          value={settings.deploy.environment}
          onChange={(v) => {
            const environment = v as 'preview' | 'production';
            updateNestedSetting('deploy', 'environment', environment);
          }}
          options={[
            { value: 'preview', label: 'Preview' },
            { value: 'production', label: 'Production' },
          ]}
        />
      </div>

      {/* Monitoring */}
      <SubsectionHeader title="Monitoring" />
      <div className="space-y-3">
        <Field
          label="Health Check URL"
          description="URL path to check if project is healthy (e.g., /api/health)"
          value={settings.monitoring.healthCheckUrl || ''}
          onChange={(v) => updateNestedSetting('monitoring', 'healthCheckUrl', v || null)}
          placeholder="/api/health"
        />

        <Toggle
          label="Restart on crash"
          description="Automatically restart if the dev server crashes"
          checked={settings.monitoring.restartOnCrash}
          onChange={(v) => updateNestedSetting('monitoring', 'restartOnCrash', v)}
        />

        <Field
          label="Log Retention (days)"
          description="How long to keep project logs"
          value={String(settings.monitoring.logRetentionDays)}
          onChange={(v) => updateNestedSetting('monitoring', 'logRetentionDays', parseInt(v) || 7)}
          type="number"
          placeholder="7"
        />
      </div>
    </div>
  );
}
