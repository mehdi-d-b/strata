import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** Fusionne des classes Tailwind en gérant les conflits (helper standard shadcn). */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
