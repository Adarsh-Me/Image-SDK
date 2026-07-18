declare module "react" {
  export function useEffect(effect: () => void | (() => void), dependencies: readonly unknown[]): void;
  export function useRef<T>(initialValue: T): { current: T };
  export function useState<T>(initialValue: T): [T, (value: T | ((previous: T) => T)) => void];
}
