import { useRef, useEffect, useCallback, useState, forwardRef, useImperativeHandle } from "react";
import { cn } from "@/lib/utils";

export interface PasteBlock {
  id: string;
  content: string;
  lineCount: number;
}

export interface FileBlock {
  id: string;
  filename: string;
  path: string;
  size: number;
  mimeType: string;
}

interface Props {
  value: string;
  onChange: (value: string) => void;
  onPasteBlock?: (block: PasteBlock) => void;
  onRemoveBlock?: (id: string) => void;
  blocks: PasteBlock[];
  fileBlocks?: FileBlock[];
  onFileSelect?: (file: File) => Promise<FileBlock | null>;
  onRemoveFileBlock?: (id: string) => void;
  enableSpeech?: boolean;
  speechLang?: string;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  onKeyDown?: (e: React.KeyboardEvent) => void;
}

const SpeechRecognitionImpl: any =
  typeof window !== "undefined"
    ? (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition
    : null;

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export interface RichPasteInputHandle {
  focus: () => void;
}

// Serialize DOM children into our placeholder format
function domToValue(root: HTMLElement): string {
  let out = "";
  const walk = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      out += node.textContent ?? "";
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      const el = node as HTMLElement;
      if (el.tagName === "BR") {
        out += "\n";
        return;
      }
      const blockId = el.dataset.blockId;
      if (blockId) {
        out += `{{paste:${blockId}}}`;
        return;
      }
      const fileId = el.dataset.fileId;
      if (fileId) {
        out += `{{file:${fileId}}}`;
        return;
      }
      // For div/span wrappers, add newline for div, recurse children
      if (el.tagName === "DIV" && out.length > 0 && !out.endsWith("\n")) {
        out += "\n";
      }
      node.childNodes.forEach(walk);
    }
  };
  root.childNodes.forEach(walk);
  return out;
}

type Token =
  | { type: "text"; text: string }
  | { type: "block"; block: PasteBlock }
  | { type: "file"; file: FileBlock };

// Parse a placeholder-containing string into an array of text and block tokens
function valueToTokens(value: string, blocks: PasteBlock[], fileBlocks: FileBlock[]): Token[] {
  const blocksById = new Map(blocks.map((b) => [b.id, b]));
  const filesById = new Map(fileBlocks.map((f) => [f.id, f]));
  const tokens: Token[] = [];
  const regex = /\{\{(paste|file):([^}]+)\}\}/g;
  let lastIndex = 0;
  let match;
  while ((match = regex.exec(value)) !== null) {
    if (match.index > lastIndex) tokens.push({ type: "text", text: value.slice(lastIndex, match.index) });
    if (match[1] === "paste") {
      const block = blocksById.get(match[2]);
      if (block) tokens.push({ type: "block", block });
    } else {
      const file = filesById.get(match[2]);
      if (file) tokens.push({ type: "file", file });
    }
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < value.length) tokens.push({ type: "text", text: value.slice(lastIndex) });
  return tokens;
}

export const RichPasteInput = forwardRef<RichPasteInputHandle, Props>(function RichPasteInput(
  { value, onChange, onPasteBlock, onRemoveBlock, blocks, fileBlocks = [], onFileSelect, onRemoveFileBlock, enableSpeech, speechLang = "fr-FR", placeholder, disabled, className, onKeyDown },
  ref
) {
  const editorRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const lastValueRef = useRef<string>("");
  const blocksRef = useRef<PasteBlock[]>(blocks);
  const fileBlocksRef = useRef<FileBlock[]>(fileBlocks);
  const [dragOver, setDragOver] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [recording, setRecording] = useState(false);
  const [interimTranscript, setInterimTranscript] = useState("");
  const [speechError, setSpeechError] = useState<string | null>(null);
  const recognitionRef = useRef<any>(null);
  const speechSupported = !!SpeechRecognitionImpl && enableSpeech !== false;
  blocksRef.current = blocks;
  fileBlocksRef.current = fileBlocks;

  useImperativeHandle(ref, () => ({
    focus: () => editorRef.current?.focus(),
  }), []);

  // Render value to DOM (only when value changes externally, not during typing)
  useEffect(() => {
    const el = editorRef.current;
    if (!el) return;
    if (value === lastValueRef.current) return; // avoid re-render during typing

    // Preserve cursor position as offset from start when rerendering external changes
    el.innerHTML = "";
    const tokens = valueToTokens(value, blocksRef.current, fileBlocksRef.current);
    for (const token of tokens) {
      if (token.type === "text") {
        // Split by newlines, add <br> between lines
        const lines = token.text.split("\n");
        lines.forEach((line, i) => {
          if (i > 0) el.appendChild(document.createElement("br"));
          if (line) el.appendChild(document.createTextNode(line));
        });
      } else if (token.type === "block") {
        const span = document.createElement("span");
        span.contentEditable = "false";
        span.dataset.blockId = token.block.id;
        span.className = "inline-flex items-center gap-1 rounded-md bg-primary/15 border border-primary/30 px-2 py-0.5 mx-0.5 text-[11px] text-primary font-mono select-none align-middle cursor-default";
        span.title = token.block.content.slice(0, 500) + (token.block.content.length > 500 ? "..." : "");
        span.textContent = `📎 ${token.block.lineCount} ligne${token.block.lineCount > 1 ? "s" : ""}`;
        el.appendChild(span);
      } else {
        const span = document.createElement("span");
        span.contentEditable = "false";
        span.dataset.fileId = token.file.id;
        span.className = "inline-flex items-center gap-1 rounded-md bg-primary/15 border border-primary/30 px-2 py-0.5 mx-0.5 text-[11px] text-primary font-mono select-none align-middle cursor-default";
        span.title = `${token.file.filename} • ${formatBytes(token.file.size)}`;
        span.textContent = `📄 ${token.file.filename} (${formatBytes(token.file.size)})`;
        el.appendChild(span);
      }
    }
    lastValueRef.current = value;
  }, [value, fileBlocks]);

  const handleInput = useCallback(() => {
    const el = editorRef.current;
    if (!el) return;
    const newValue = domToValue(el);
    lastValueRef.current = newValue;

    // Detect removed paste blocks (blocks in state but no longer in DOM)
    const currentBlockIds = new Set<string>();
    el.querySelectorAll("[data-block-id]").forEach((n) => {
      const id = (n as HTMLElement).dataset.blockId;
      if (id) currentBlockIds.add(id);
    });
    for (const block of blocksRef.current) {
      if (!currentBlockIds.has(block.id)) {
        onRemoveBlock?.(block.id);
      }
    }

    // Detect removed file blocks
    const currentFileIds = new Set<string>();
    el.querySelectorAll("[data-file-id]").forEach((n) => {
      const id = (n as HTMLElement).dataset.fileId;
      if (id) currentFileIds.add(id);
    });
    for (const file of fileBlocksRef.current) {
      if (!currentFileIds.has(file.id)) {
        onRemoveFileBlock?.(file.id);
      }
    }

    onChange(newValue);
  }, [onChange, onRemoveBlock, onRemoveFileBlock]);

  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    const pasted = e.clipboardData.getData("text");
    const lineCount = pasted.split("\n").length;

    if (lineCount <= 5) {
      // Short paste: insert as plain text at cursor
      e.preventDefault();
      document.execCommand("insertText", false, pasted);
      return;
    }

    // Long paste: insert a block chip at cursor
    e.preventDefault();
    const id = crypto.randomUUID();
    const block: PasteBlock = { id, content: pasted, lineCount };

    const span = document.createElement("span");
    span.contentEditable = "false";
    span.dataset.blockId = id;
    span.className = "inline-flex items-center gap-1 rounded-md bg-primary/15 border border-primary/30 px-2 py-0.5 mx-0.5 text-[11px] text-primary font-mono select-none align-middle cursor-default";
    span.title = pasted.slice(0, 500) + (pasted.length > 500 ? "..." : "");
    span.textContent = `📎 ${lineCount} lignes`;

    const selection = window.getSelection();
    if (selection && selection.rangeCount > 0) {
      const range = selection.getRangeAt(0);
      range.deleteContents();
      range.insertNode(span);
      // Move cursor after the inserted span
      range.setStartAfter(span);
      range.setEndAfter(span);
      selection.removeAllRanges();
      selection.addRange(range);
    } else {
      editorRef.current?.appendChild(span);
    }

    onPasteBlock?.(block);

    // Trigger onChange with new value
    setTimeout(() => {
      const el = editorRef.current;
      if (!el) return;
      const newValue = domToValue(el);
      lastValueRef.current = newValue;
      onChange(newValue);
    }, 0);
  }, [onChange, onPasteBlock]);

  const insertTextAtCursor = useCallback((text: string) => {
    const el = editorRef.current;
    if (!el || !text) return;
    el.focus();
    const selection = window.getSelection();
    const editorContains = selection && selection.rangeCount > 0 && el.contains(selection.anchorNode);
    if (!editorContains) {
      // Place cursor at end of editor
      const range = document.createRange();
      range.selectNodeContents(el);
      range.collapse(false);
      selection?.removeAllRanges();
      selection?.addRange(range);
    }
    document.execCommand("insertText", false, text);
    // Trigger onChange via the input event listener
    const newValue = domToValue(el);
    lastValueRef.current = newValue;
    onChange(newValue);
  }, [onChange]);

  const stopRecording = useCallback(() => {
    const rec = recognitionRef.current;
    if (rec) {
      try { rec.stop(); } catch {}
    }
    setRecording(false);
    setInterimTranscript("");
  }, []);

  const startRecording = useCallback(() => {
    if (!speechSupported || disabled || recording) return;
    setSpeechError(null);
    let recognition: any;
    try {
      recognition = new SpeechRecognitionImpl();
    } catch (err) {
      setSpeechError("Reconnaissance vocale non disponible");
      return;
    }
    recognition.lang = speechLang;
    recognition.continuous = true;
    recognition.interimResults = true;

    let finalText = "";
    recognition.onresult = (e: any) => {
      let interim = "";
      let appended = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const result = e.results[i];
        const text = result[0].transcript;
        if (result.isFinal) appended += text;
        else interim += text;
      }
      if (appended) {
        finalText += appended;
        insertTextAtCursor(appended);
      }
      setInterimTranscript(interim);
    };
    recognition.onerror = (e: any) => {
      const code = e?.error ?? "unknown";
      if (code === "no-speech" || code === "aborted") {
        // benign, ignore
      } else if (code === "not-allowed" || code === "service-not-allowed") {
        setSpeechError("Microphone refuse. Autorise-le dans les permissions du navigateur.");
      } else if (code === "network") {
        setSpeechError(
          "Erreur reseau : Web Speech route l'audio via Google. Sur Arc/Brave, desactive le shield/privacy block pour cette page (ou utilise Chrome)."
        );
      } else if (code === "audio-capture") {
        setSpeechError("Aucun micro detecte. Branche un micro ou verifie le device par defaut.");
      } else if (code === "language-not-supported") {
        setSpeechError(`Langue non supportee (${recognition.lang}).`);
      } else {
        setSpeechError(`Erreur: ${code}`);
      }
    };
    recognition.onend = () => {
      setRecording(false);
      setInterimTranscript("");
      recognitionRef.current = null;
    };

    recognitionRef.current = recognition;
    try {
      recognition.start();
      setRecording(true);
    } catch (err: any) {
      setSpeechError(err?.message ?? "Erreur lors du demarrage");
      recognitionRef.current = null;
    }
  }, [speechSupported, disabled, recording, speechLang, insertTextAtCursor]);

  const insertFileBlock = useCallback((file: FileBlock) => {
    const el = editorRef.current;
    if (!el) return;
    const span = document.createElement("span");
    span.contentEditable = "false";
    span.dataset.fileId = file.id;
    span.className = "inline-flex items-center gap-1 rounded-md bg-primary/15 border border-primary/30 px-2 py-0.5 mx-0.5 text-[11px] text-primary font-mono select-none align-middle cursor-default";
    span.title = `${file.filename} • ${formatBytes(file.size)}`;
    span.textContent = `📄 ${file.filename} (${formatBytes(file.size)})`;

    const selection = window.getSelection();
    const editorContains = selection && selection.rangeCount > 0 && el.contains(selection.anchorNode);
    if (editorContains) {
      const range = selection!.getRangeAt(0);
      range.deleteContents();
      range.insertNode(span);
      range.setStartAfter(span);
      range.setEndAfter(span);
      selection!.removeAllRanges();
      selection!.addRange(range);
    } else {
      el.appendChild(span);
    }

    setTimeout(() => {
      const newValue = domToValue(el);
      lastValueRef.current = newValue;
      onChange(newValue);
    }, 0);
  }, [onChange]);

  const handleFiles = useCallback(async (files: FileList | File[]) => {
    if (!onFileSelect) return;
    setUploading(true);
    try {
      for (const file of Array.from(files)) {
        const block = await onFileSelect(file);
        if (block) insertFileBlock(block);
      }
    } finally {
      setUploading(false);
    }
  }, [onFileSelect, insertFileBlock]);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    if (disabled) return;
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      handleFiles(e.dataTransfer.files);
    }
  }, [disabled, handleFiles]);

  const handleAttachClick = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleFileInputChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      handleFiles(e.target.files);
    }
    // Reset so re-selecting the same file fires onChange again
    e.target.value = "";
  }, [handleFiles]);

  const isEmpty = !value || value.length === 0;

  return (
    <div className="relative flex-1 min-w-0">
      {isEmpty && placeholder && (
        <div className="pointer-events-none absolute left-4 top-3 text-sm text-muted-foreground">
          {placeholder}
        </div>
      )}
      {onFileSelect && (
        <>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={handleFileInputChange}
            disabled={disabled}
          />
          <button
            type="button"
            onClick={handleAttachClick}
            disabled={disabled || uploading}
            title={uploading ? "Upload en cours..." : "Joindre un fichier"}
            className="absolute right-2 top-2 z-10 rounded-md p-1.5 text-muted-foreground hover:bg-secondary-foreground/10 hover:text-foreground disabled:opacity-50"
          >
            {uploading ? (
              <span className="block h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
            ) : (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 17.93 8.8l-8.58 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48" />
              </svg>
            )}
          </button>
        </>
      )}
      {speechSupported && (
        <button
          type="button"
          onClick={() => (recording ? stopRecording() : startRecording())}
          disabled={disabled}
          title={recording ? "Clique pour arreter l'ecoute" : "Clique pour parler"}
          className={cn(
            "absolute z-10 rounded-md p-1.5 select-none transition-colors",
            onFileSelect ? "right-10" : "right-2",
            "top-2",
            recording
              ? "bg-red-500/20 text-red-400 ring-2 ring-red-500/40 animate-pulse"
              : "text-muted-foreground hover:bg-secondary-foreground/10 hover:text-foreground",
            "disabled:opacity-50"
          )}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
            <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
            <line x1="12" y1="19" x2="12" y2="23" />
            <line x1="8" y1="23" x2="16" y2="23" />
          </svg>
        </button>
      )}
      <div
        ref={editorRef}
        contentEditable={!disabled}
        suppressContentEditableWarning
        onInput={handleInput}
        onPaste={handlePaste}
        onKeyDown={onKeyDown}
        onDragOver={(e) => { if (onFileSelect) { e.preventDefault(); setDragOver(true); } }}
        onDragLeave={() => setDragOver(false)}
        onDrop={handleDrop}
        className={cn(
          "w-full h-full min-h-full resize-none overflow-y-auto rounded-lg border bg-secondary px-4 py-3 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-ring whitespace-pre-wrap break-words",
          (onFileSelect || speechSupported) && "pr-9",
          onFileSelect && speechSupported && "pr-16",
          dragOver && "ring-2 ring-primary/60 bg-primary/5",
          recording && "ring-2 ring-red-500/40",
          disabled && "opacity-50 cursor-not-allowed",
          className
        )}
        style={{ minHeight: "100%" }}
      />
      {recording && (
        <div className="absolute bottom-1 left-3 right-3 flex items-center gap-2 text-[11px] text-red-400 pointer-events-none">
          <span className="inline-block h-2 w-2 rounded-full bg-red-500 animate-pulse" />
          <span className="font-mono">
            {interimTranscript ? `"${interimTranscript}"` : "Ecoute... (clique a nouveau pour arreter)"}
          </span>
        </div>
      )}
      {speechError && !recording && (
        <div className="absolute -bottom-5 left-3 text-[10px] text-red-400">{speechError}</div>
      )}
    </div>
  );
});
