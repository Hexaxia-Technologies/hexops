'use client';

import { useState, useEffect, useCallback } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Loader2, FolderOpen, Check, AlertCircle } from 'lucide-react';
import { toast } from 'sonner';
import type { ProjectConfig } from '@/lib/types';

interface ScanResult {
  exists: boolean;
  path: string;
  name: string;
  description: string;
  suggestedPort: number;
  suggestedId: string;
  scripts: {
    dev: string;
    build: string;
  };
  availableScripts: string[];
  hasPackageJson: boolean;
}

interface AddProjectDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess: () => void;
  categories: string[];
  editProject?: ProjectConfig | null;
}

export function AddProjectDialog({
  open,
  onOpenChange,
  onSuccess,
  categories,
  editProject,
}: AddProjectDialogProps) {
  const isEdit = !!editProject;

  // Form state
  const [path, setPath] = useState('');
  const [name, setName] = useState('');
  const [id, setId] = useState('');
  const [description, setDescription] = useState('');
  const [port, setPort] = useState('');
  const [category, setCategory] = useState('');
  const [newCategory, setNewCategory] = useState('');
  const [devScript, setDevScript] = useState('pnpm dev');
  const [buildScript, setBuildScript] = useState('pnpm build');

  // UI state
  const [isScanning, setIsScanning] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [scanResult, setScanResult] = useState<ScanResult | null>(null);
  const [pathError, setPathError] = useState<string | null>(null);
  const [showNewCategory, setShowNewCategory] = useState(false);

  // Reset form when dialog opens/closes or edit project changes
  useEffect(() => {
    if (open) {
      if (editProject) {
        setPath(editProject.path);
        setName(editProject.name);
        setId(editProject.id);
        setDescription(editProject.description || '');
        setPort(String(editProject.port));
        setCategory(editProject.category);
        setDevScript(editProject.scripts.dev);
        setBuildScript(editProject.scripts.build);
        setScanResult(null);
        setPathError(null);
        setShowNewCategory(false);
        setNewCategory('');
      } else {
        setPath('');
        setName('');
        setId('');
        setDescription('');
        setPort('');
        setCategory(categories[0] || '');
        setDevScript('pnpm dev');
        setBuildScript('pnpm build');
        setScanResult(null);
        setPathError(null);
        setShowNewCategory(false);
        setNewCategory('');
      }
    }
  }, [open, editProject, categories]);

  const scanPath = useCallback(async (pathToScan: string) => {
    if (!pathToScan.trim()) return;

    setIsScanning(true);
    setPathError(null);

    try {
      const res = await fetch('/api/projects/scan-path', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: pathToScan }),
      });

      const data = await res.json();

      if (!res.ok) {
        setPathError(data.error || 'Failed to scan path');
        setScanResult(null);
        return;
      }

      setScanResult(data);

      // Auto-fill fields if not in edit mode
      if (!isEdit) {
        setPath(data.path);
        setName(data.name);
        setId(data.suggestedId);
        setDescription(data.description || '');
        setPort(String(data.suggestedPort));
        setDevScript(data.scripts.dev);
        setBuildScript(data.scripts.build);
      }
    } catch {
      setPathError('Failed to scan path');
      setScanResult(null);
    } finally {
      setIsScanning(false);
    }
  }, [isEdit]);

  const handlePathBlur = () => {
    if (path.trim() && !isEdit) {
      scanPath(path);
    }
  };

  const handlePathKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && path.trim() && !isEdit) {
      e.preventDefault();
      scanPath(path);
    }
  };

  const handleSave = async () => {
    // Validate
    if (!path.trim()) {
      toast.error('Path is required');
      return;
    }
    if (!name.trim()) {
      toast.error('Name is required');
      return;
    }
    if (!id.trim()) {
      toast.error('ID is required');
      return;
    }
    if (!port.trim() || isNaN(Number(port))) {
      toast.error('Valid port is required');
      return;
    }

    const finalCategory = showNewCategory ? newCategory.trim() : category;
    if (!finalCategory) {
      toast.error('Category is required');
      return;
    }

    setIsSaving(true);

    try {
      const project: ProjectConfig = {
        id: id.trim(),
        name: name.trim(),
        path: path.trim(),
        port: Number(port),
        category: finalCategory,
        description: description.trim() || undefined,
        scripts: {
          dev: devScript.trim() || 'pnpm dev',
          build: buildScript.trim() || 'pnpm build',
        },
      };

      const res = await fetch('/api/projects/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project, isNew: !isEdit }),
      });

      const data = await res.json();

      if (!res.ok) {
        toast.error(data.error || 'Failed to save project');
        return;
      }

      toast.success(isEdit ? 'Project updated' : 'Project added');
      onOpenChange(false);
      onSuccess();
    } catch {
      toast.error('Failed to save project');
    } finally {
      setIsSaving(false);
    }
  };

  const handleCategoryChange = (value: string) => {
    if (value === '__new__') {
      setShowNewCategory(true);
      setCategory('');
    } else {
      setShowNewCategory(false);
      setCategory(value);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg bg-zinc-900 border-zinc-800">
        <DialogHeader>
          <DialogTitle className="text-zinc-100">
            {isEdit ? 'Edit Project' : 'Add Project'}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-4">
          {/* Path */}
          <div className="space-y-2">
            <label className="text-sm font-medium text-zinc-300">
              Project Path
            </label>
            <div className="relative">
              <FolderOpen className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-zinc-500" />
              <Input
                value={path}
                onChange={(e) => setPath(e.target.value)}
                onBlur={handlePathBlur}
                onKeyDown={handlePathKeyDown}
                placeholder="/path/to/project"
                className="pl-10 bg-zinc-800 border-zinc-700 text-zinc-100"
                disabled={isEdit}
              />
              {isScanning && (
                <Loader2 className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 text-zinc-500 animate-spin" />
              )}
              {scanResult && !isScanning && (
                <Check className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 text-green-500" />
              )}
            </div>
            {pathError && (
              <p className="text-sm text-red-400 flex items-center gap-1">
                <AlertCircle className="h-3 w-3" />
                {pathError}
              </p>
            )}
            {scanResult?.hasPackageJson && (
              <p className="text-xs text-zinc-500">
                Detected package.json - fields auto-populated
              </p>
            )}
          </div>

          {/* Name and ID row */}
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <label className="text-sm font-medium text-zinc-300">Name</label>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="My Project"
                className="bg-zinc-800 border-zinc-700 text-zinc-100"
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium text-zinc-300">ID</label>
              <Input
                value={id}
                onChange={(e) => setId(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-'))}
                placeholder="my-project"
                className="bg-zinc-800 border-zinc-700 text-zinc-100"
                disabled={isEdit}
              />
            </div>
          </div>

          {/* Description */}
          <div className="space-y-2">
            <label className="text-sm font-medium text-zinc-300">
              Description <span className="text-zinc-500">(optional)</span>
            </label>
            <Input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Brief project description"
              className="bg-zinc-800 border-zinc-700 text-zinc-100"
            />
          </div>

          {/* Port and Category row */}
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <label className="text-sm font-medium text-zinc-300">Port</label>
              <Input
                type="number"
                value={port}
                onChange={(e) => setPort(e.target.value)}
                placeholder="3000"
                min={1024}
                max={65535}
                className="bg-zinc-800 border-zinc-700 text-zinc-100"
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium text-zinc-300">Category</label>
              {showNewCategory ? (
                <div className="flex gap-2">
                  <Input
                    value={newCategory}
                    onChange={(e) => setNewCategory(e.target.value)}
                    placeholder="New category"
                    className="bg-zinc-800 border-zinc-700 text-zinc-100"
                    autoFocus
                  />
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setShowNewCategory(false)}
                    className="text-zinc-400"
                  >
                    Cancel
                  </Button>
                </div>
              ) : (
                <select
                  value={category}
                  onChange={(e) => handleCategoryChange(e.target.value)}
                  className="w-full h-9 px-3 rounded-md border border-zinc-700 bg-zinc-800 text-zinc-100 text-sm"
                >
                  {categories.map((cat) => (
                    <option key={cat} value={cat}>
                      {cat}
                    </option>
                  ))}
                  <option value="__new__">+ Add new category...</option>
                </select>
              )}
            </div>
          </div>

          {/* Scripts */}
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <label className="text-sm font-medium text-zinc-300">Dev Script</label>
              <Input
                value={devScript}
                onChange={(e) => setDevScript(e.target.value)}
                placeholder="pnpm dev"
                className="bg-zinc-800 border-zinc-700 text-zinc-100 font-mono text-sm"
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium text-zinc-300">Build Script</label>
              <Input
                value={buildScript}
                onChange={(e) => setBuildScript(e.target.value)}
                placeholder="pnpm build"
                className="bg-zinc-800 border-zinc-700 text-zinc-100 font-mono text-sm"
              />
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button
            variant="ghost"
            onClick={() => onOpenChange(false)}
            disabled={isSaving}
            className="text-zinc-400"
          >
            Cancel
          </Button>
          <Button
            onClick={handleSave}
            disabled={isSaving || isScanning}
            className="bg-blue-600 hover:bg-blue-700"
          >
            {isSaving ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Saving...
              </>
            ) : isEdit ? (
              'Save Changes'
            ) : (
              'Add Project'
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
