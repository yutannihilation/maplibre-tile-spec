import type { Geometry, GeometryVector, GeometryZ } from "./geometry/geometryVector";
import type { CoordinateDimension } from "./geometry/coordinateDimension";
import type Vector from "./vector";
import type { IdVector } from "./idVector";
import { Int32FlatVector } from "./flat/int32FlatVector";
import { DoubleFlatVector } from "./flat/doubleFlatVector";
import { Int32SequenceVector } from "./sequence/int32SequenceVector";
import { Int32ConstVector } from "./constant/int32ConstVector";
import type { GpuVector } from "./geometry/gpuVector";

export interface Feature {
    id: number | bigint;
    /**
     * A 2D {@link Geometry} or a 3D {@link GeometryZ} depending on the layer's column type.
     * Discriminate per layer with {@link FeatureTable.numDimensions}; it never varies per feature.
     */
    geometry: Geometry | GeometryZ;
    properties: { [key: string]: unknown };
}

export default class FeatureTable {
    private propertyVectorsMap: Map<string, Vector>;

    constructor(
        private readonly _name: string,
        private readonly _geometryVector: GeometryVector | GpuVector,
        private readonly _idVector?: IdVector,
        private readonly _propertyVectors?: Vector[],
        private readonly _extent = 4096,
    ) {
        if (_name.length === 0) {
            throw new Error("Missing layer name");
        }
    }

    get name(): string {
        return this._name;
    }

    get idVector(): IdVector {
        return this._idVector;
    }

    get geometryVector(): GeometryVector | GpuVector {
        return this._geometryVector;
    }

    get propertyVectors(): Vector[] {
        return this._propertyVectors;
    }

    getPropertyVector(name: string): Vector {
        if (!this.propertyVectorsMap) {
            this.propertyVectorsMap = new Map(this._propertyVectors.map((vector) => [vector.name, vector]));
        }

        return this.propertyVectorsMap.get(name);
    }

    get numFeatures(): number {
        return this.geometryVector.numGeometries;
    }

    /**
     * Coordinate dimensionality of this layer's geometry: 3 for `GEOMETRY_Z` columns, otherwise 2.
     * A per-layer property (decided by the column type), so it is the right place to discriminate
     * between {@link Geometry} and {@link GeometryZ} on the features.
     */
    get numDimensions(): CoordinateDimension {
        return this.geometryVector.numDimensions;
    }

    get extent(): number {
        return this._extent;
    }

    /**
     * Returns all features as an array
     */
    getFeatures(): Feature[] {
        const features: Feature[] = [];
        const geometries = this.geometryVector.getGeometries();

        for (let i = 0; i < this.numFeatures; i++) {
            let id;
            if (this.idVector) {
                const idValue = this.idVector.getValue(i);
                id = this.containsMaxSafeIntegerValues(this.idVector) && idValue !== null ? Number(idValue) : idValue;
            }
            // coordinates is Point[][] for 2D columns and PointZ[][] for 3D columns, uniform per
            // layer (see FeatureTable.numDimensions). The cast picks the matching union member.
            const geometry = {
                coordinates: geometries[i],
                type: this.geometryVector.geometryType(i),
            } as Geometry | GeometryZ;

            const properties: { [key: string]: unknown } = {};
            for (const propertyColumn of this.propertyVectors) {
                if (!propertyColumn) continue;
                const columnName = propertyColumn.name;
                const propertyValue = propertyColumn.getValue(i);
                if (propertyValue !== null) {
                    properties[columnName] = propertyValue;
                }
            }

            features.push({ id, geometry, properties });
        }
        return features;
    }

    private containsMaxSafeIntegerValues(idVector: IdVector) {
        return (
            idVector instanceof Int32FlatVector ||
            idVector instanceof Int32ConstVector ||
            idVector instanceof Int32SequenceVector ||
            idVector instanceof DoubleFlatVector
        );
    }
}
