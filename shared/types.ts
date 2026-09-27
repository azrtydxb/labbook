// Domain types shared by the server and the web app. No runtime dependencies.

export type ValueType = 'number' | 'boolean' | 'string';
export type Better = 'higher' | 'lower' | 'none';
export type RunStatus = 'pass' | 'fail' | 'error' | 'info';
export type Scalar = number | boolean | string | null;

export interface ParameterDef {
  key: string;
  label: string;
  description: string;
  /**
   * Identity parameters decide which runs are comparable: a run's baseline is the
   * previous run of the same type whose identity parameters are equal (e.g. model
   * and gpu), while non-identity ones (commit, label) are free to differ.
   */
  identity: boolean;
}

export interface Bounds {
  /** Absolute lower bound (inclusive). */
  min?: number;
  /** Absolute upper bound (inclusive). */
  max?: number;
  /** Lower bound as a fraction of the baseline value, e.g. 0.97 = at most 3% below. */
  relMin?: number;
  /** Upper bound as a fraction of the baseline value, e.g. 1.10 = at most 10% above. */
  relMax?: number;
  /** Expected value for boolean and string data points. */
  expected?: boolean | string;
}

export interface DataPointDef {
  key: string;
  label: string;
  unit: string;
  type: ValueType;
  better: Better;
  description: string;
  bounds?: Bounds;
}

export interface TypeDefinition {
  parameters: ParameterDef[];
  dataPoints: DataPointDef[];
  /** Key of the headline data point (sparklines, dashboards). Defaults to the first number. */
  primary?: string;
}

export type Verdict = 'pass' | 'fail' | 'none' | 'missing';

export interface PointEvaluation {
  key: string;
  value: Scalar | undefined;
  baseline: Scalar | undefined;
  delta: number | null;
  deltaPct: number | null;
  /** true when the change goes in the "better" direction, false when worse, null if n/a. */
  improved: boolean | null;
  verdict: Verdict;
  reasons: string[];
}

export interface RunEvaluation {
  verdict: 'pass' | 'fail' | 'none';
  points: PointEvaluation[];
}
