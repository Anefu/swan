import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { cls } from "../util";
import { IconSearch } from "./icons";

/**
 * A menu of options under a trigger button (the persona and conversation pickers): open and close,
 * the active row, keyboard moves, an optional search, and closing on a click outside.
 */
export function useListMenu(o: {
  /** Rows in the list now; it can depend on the menu's own query. */
  count: () => number;
  choose: (i: number) => void;
  /** Arrows, Home, End and Enter move and choose only while the list is showing. */
  navigating?: boolean;
  /** Escape while something else shows (a form in the menu): back to the list instead of closing. */
  back?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const listId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const navigating = o.navigating ?? true;

  const close = (refocus = true) => {
    setOpen(false);
    setQuery("");
    if (refocus) triggerRef.current?.focus();
  };
  const openAt = (i: number) => {
    setOpen(true);
    setActive(Math.max(0, i));
  };

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) close(false);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  // The search takes focus when there is one, otherwise the list, so keys work at once.
  useEffect(() => {
    if (open && navigating) (searchRef.current ?? listRef.current)?.focus();
  }, [open, navigating]);

  // The list can shrink under the active row (a search, a conversation gone).
  useEffect(() => {
    const last = o.count() - 1;
    if (active > last) setActive(Math.max(0, last));
  });

  useEffect(() => {
    if (open) document.getElementById(`${listId}-${active}`)?.scrollIntoView({ block: "nearest" });
  }, [active, open, listId]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!open) return;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      if (!navigating && o.back) o.back();
      else close();
      return;
    }
    if (!navigating) return;
    const last = o.count() - 1;
    const move: Record<string, () => number> = {
      ArrowDown: () => (active >= last ? 0 : active + 1),
      ArrowUp: () => (active <= 0 ? last : active - 1),
      Home: () => 0,
      End: () => last,
    };
    if (move[e.key]) {
      e.preventDefault();
      setActive(move[e.key]!());
    } else if (e.key === "Enter") {
      e.preventDefault();
      o.choose(active);
    } else if (e.key === "Tab") close(false);
  };

  return { open, query, setQuery, active, setActive, listId, rootRef, triggerRef, listRef, searchRef, close, openAt, onKeyDown, optionId: (i: number) => `${listId}-${i}` };
}

export type ListMenu = ReturnType<typeof useListMenu>;

/** The search box at the top of a long menu. */
export function MenuSearch({ menu, label }: { menu: ListMenu; label: string }) {
  return (
    <label className="search-field">
      <IconSearch size={16} />
      <span className="sr-only">{label}</span>
      <input
        ref={menu.searchRef}
        placeholder={label}
        value={menu.query}
        onChange={(e) => {
          menu.setQuery(e.target.value);
          menu.setActive(0);
        }}
        role="combobox"
        aria-controls={menu.listId}
        aria-expanded="true"
        aria-activedescendant={menu.optionId(menu.active)}
      />
    </label>
  );
}

/** The list of options; the search, when there is one, keeps focus and points into it. */
export function MenuList({ menu, label, searching, children }: { menu: ListMenu; label: string; searching: boolean; children: ReactNode }) {
  return (
    <ul ref={menu.listRef} id={menu.listId} role="listbox" aria-label={label} tabIndex={searching ? -1 : 0} aria-activedescendant={menu.optionId(menu.active)} className="persona-list">
      {children}
    </ul>
  );
}

/** One option: a mark (a check, or an icon), its text, and something on the right. */
export function MenuOption({
  menu,
  index,
  onChoose,
  selected = false,
  className,
  mark,
  aside,
  children,
}: {
  menu: ListMenu;
  index: number;
  onChoose: (i: number) => void;
  selected?: boolean;
  className?: string;
  mark?: ReactNode;
  aside?: ReactNode;
  children: ReactNode;
}) {
  return (
    <li
      id={menu.optionId(index)}
      role="option"
      aria-selected={selected}
      className={cls("persona-opt", className, index === menu.active && "is-active")}
      onMouseEnter={() => menu.setActive(index)}
      onClick={() => onChoose(index)}
    >
      <span className="persona-check">{mark}</span>
      <span className="persona-opt-main">{children}</span>
      {aside}
    </li>
  );
}
