import { createContext } from 'react';
export const PreviewContext = createContext<((path: string) => void) | null>(
  null,
);
