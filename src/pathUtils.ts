import { SchemaValueType } from './schema';

export type PathSegment = string | number;

export function buildPathKey(segments: PathSegment[]): string {
	if (segments.length === 0) {
		return '';
	}

	return segments
		.map((segment, index) => {
			if (typeof segment === 'number') {
				return `[${segment}]`;
			}

			return index === 0 ? segment : `.${segment}`;
		})
		.join('');
}

export function parsePathKey(pathKey: string): PathSegment[] {
	if (!pathKey) {
		return [];
	}

	const tokens = pathKey.match(/[^.[\]]+|\[\d+\]/g);
	if (!tokens) {
		return [];
	}

	return tokens.map((token) => {
		if (token.startsWith('[') && token.endsWith(']')) {
			const index = Number.parseInt(token.slice(1, -1), 10);
			return Number.isNaN(index) ? token : index;
		}

		return token;
	});
}

export function setValueAtPath(target: unknown, segments: PathSegment[], newValue: unknown): boolean {
	if (segments.length === 0) {
		return false;
	}

	const containerSegments = segments.slice(0, -1);
	let current: any = target;
	for (const segment of containerSegments) {
		if (typeof current !== 'object' || current === null) {
			return false;
		}

		current = current[segment as keyof typeof current];
	}

	const last = segments[segments.length - 1];
	if (typeof current !== 'object' || current === null) {
		return false;
	}

	current[last as keyof typeof current] = newValue;
	return true;
}

export function getValueAtPath(target: unknown, segments: PathSegment[]): unknown {
	if (segments.length === 0) {
		return target;
	}

	let current: any = target;
	for (const segment of segments) {
		if (typeof current !== 'object' || current === null) {
			return undefined;
		}

		current = current[segment as keyof typeof current];
	}

	return current;
}

export function inferSchemaType(value: unknown): SchemaValueType {
	if (typeof value === 'number') {
		return Number.isInteger(value) ? 'integer' : 'number';
	}

	if (typeof value === 'boolean') {
		return 'boolean';
	}

	return 'string';
}
