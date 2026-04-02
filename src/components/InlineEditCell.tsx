import { useState, useRef, useEffect } from "react";
import { Input } from "@/components/ui/input";

interface InlineEditCellProps {
  value: number | null;
  prefix?: string;
  suffix?: string;
  placeholder?: string;
  align?: "left" | "center" | "right";
  className?: string;
  onSave: (newValue: number) => void;
}

const InlineEditCell = ({
  value,
  prefix = "",
  suffix = "",
  placeholder = "—",
  align = "right",
  className = "",
  onSave,
}: InlineEditCellProps) => {
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editing]);

  const handleClick = () => {
    setEditValue(value?.toString() ?? "");
    setEditing(true);
  };

  const handleSave = () => {
    const num = parseFloat(editValue);
    if (!isNaN(num) && num !== value) {
      onSave(num);
    }
    setEditing(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") handleSave();
    if (e.key === "Escape") setEditing(false);
  };

  if (editing) {
    return (
      <Input
        ref={inputRef}
        type="number"
        step="0.01"
        value={editValue}
        onChange={(e) => setEditValue(e.target.value)}
        onBlur={handleSave}
        onKeyDown={handleKeyDown}
        className={`w-24 h-7 text-sm ${align === "right" ? "text-right ml-auto" : align === "center" ? "text-center mx-auto" : "text-left"} ${className}`}
      />
    );
  }

  return (
    <span
      onClick={handleClick}
      className={`text-sm cursor-pointer hover:bg-muted/50 rounded px-1.5 py-0.5 transition-colors inline-block ${className}`}
      title="Click to edit"
    >
      {value != null ? `${prefix}${value.toFixed(2)}${suffix}` : placeholder}
    </span>
  );
};

export default InlineEditCell;
