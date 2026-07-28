import React, { useCallback, useState } from 'react';
import type { ProductSet } from '../App';

interface Props {
  onProcessed: (results: ProductSet[]) => void;
}

interface FileGroup {
  front: File | null;
  ingredients: File | null;
  barcode: File | null;
}

export default function UploadStep({ onProcessed }: Props) {
  const [groups, setGroups] = useState<FileGroup[]>([{ front: null, ingredients: null, barcode: null }]);
  const [processing, setProcessing] = useState(false);
  const [progress, setProgress] = useState('');

  const addGroup = () => {
    setGroups(g => [...g, { front: null, ingredients: null, barcode: null }]);
  };

  const removeGroup = (idx: number) => {
    setGroups(g => g.filter((_, i) => i !== idx));
  };

  const updateFile = (idx: number, role: keyof FileGroup, file: File | null) => {
    setGroups(g => g.map((group, i) => i === idx ? { ...group, [role]: file } : group));
  };

  const handleSubmit = async () => {
    const validGroups = groups.filter(g => g.front && g.ingredients);
    if (validGroups.length === 0) return;

    setProcessing(true);
    const results: ProductSet[] = [];

    for (let i = 0; i < validGroups.length; i++) {
      const g = validGroups[i];
      setProgress(`Processing ${i + 1} / ${validGroups.length}...`);

      const formData = new FormData();
      formData.append('front', g.front!);
      formData.append('ingredients', g.ingredients!);
      if (g.barcode) formData.append('barcode', g.barcode);

      try {
        const res = await fetch('/api/batch/process', { method: 'POST', body: formData });
        const data = await res.json();
        if (data.id) results.push(data);
      } catch (e) {
        console.error(`Failed to process set ${i + 1}:`, e);
      }
    }

    setProcessing(false);
    setProgress('');
    if (results.length > 0) onProcessed(results);
  };

  const validCount = groups.filter(g => g.front && g.ingredients).length;

  return (
    <div>
      <p style={{ color: '#5C6B66', marginBottom: 16 }}>
        Upload product photos in sets of 3: front label, ingredients, barcode (optional).
      </p>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {groups.map((group, idx) => (
          <div key={idx} style={styles.groupCard}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
              <strong style={{ fontSize: 14 }}>Product {idx + 1}</strong>
              {groups.length > 1 && (
                <button onClick={() => removeGroup(idx)} style={styles.removeBtn}>✕</button>
              )}
            </div>
            <div style={{ display: 'flex', gap: 12 }}>
              <FileSlot label="Front Label" file={group.front} onChange={f => updateFile(idx, 'front', f)} required />
              <FileSlot label="Ingredients" file={group.ingredients} onChange={f => updateFile(idx, 'ingredients', f)} required />
              <FileSlot label="Barcode" file={group.barcode} onChange={f => updateFile(idx, 'barcode', f)} />
            </div>
          </div>
        ))}
      </div>

      <div style={{ marginTop: 16, display: 'flex', gap: 12, alignItems: 'center' }}>
        <button onClick={addGroup} style={styles.addBtn}>+ Add Product</button>
        <button
          onClick={handleSubmit}
          disabled={validCount === 0 || processing}
          style={{ ...styles.submitBtn, opacity: validCount === 0 || processing ? 0.5 : 1 }}
        >
          {processing ? progress : `Process ${validCount} Product${validCount !== 1 ? 's' : ''}`}
        </button>
      </div>
    </div>
  );
}

function FileSlot({ label, file, onChange, required }: {
  label: string; file: File | null; onChange: (f: File | null) => void; required?: boolean;
}) {
  const inputRef = React.useRef<HTMLInputElement>(null);

  return (
    <div
      onClick={() => inputRef.current?.click()}
      style={{
        ...styles.fileSlot,
        borderColor: file ? '#2e7d56' : required ? '#ccc' : '#e0e0e0',
        background: file ? '#e8f5e9' : '#fafafa',
      }}
    >
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        style={{ display: 'none' }}
        onChange={e => onChange(e.target.files?.[0] || null)}
      />
      {file ? (
        <div style={{ textAlign: 'center' }}>
          <img src={URL.createObjectURL(file)} style={{ width: 60, height: 60, objectFit: 'cover', borderRadius: 6 }} />
          <p style={{ fontSize: 11, marginTop: 4, color: '#5C6B66' }}>{file.name.slice(0, 15)}</p>
        </div>
      ) : (
        <div style={{ textAlign: 'center' }}>
          <p style={{ fontSize: 20, color: '#aaa' }}>📷</p>
          <p style={{ fontSize: 12, color: '#888' }}>{label}</p>
          {required && <p style={{ fontSize: 10, color: '#e53935' }}>Required</p>}
        </div>
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  groupCard: {
    background: '#fff',
    borderRadius: 12,
    padding: 16,
    boxShadow: '0 1px 4px rgba(0,0,0,0.08)',
  },
  fileSlot: {
    flex: 1,
    minHeight: 100,
    border: '2px dashed #ccc',
    borderRadius: 10,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    cursor: 'pointer',
    padding: 8,
  },
  removeBtn: {
    background: 'none',
    border: 'none',
    color: '#e53935',
    fontSize: 16,
    cursor: 'pointer',
  },
  addBtn: {
    background: '#fff',
    border: '1px solid #2e7d56',
    color: '#2e7d56',
    padding: '10px 20px',
    borderRadius: 8,
    cursor: 'pointer',
    fontWeight: 600,
    fontSize: 14,
  },
  submitBtn: {
    background: '#2e7d56',
    border: 'none',
    color: '#fff',
    padding: '10px 24px',
    borderRadius: 8,
    cursor: 'pointer',
    fontWeight: 600,
    fontSize: 14,
  },
};
