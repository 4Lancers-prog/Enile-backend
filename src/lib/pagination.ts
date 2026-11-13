import type { FilterQuery, Model, PipelineStage, SortOrder } from 'mongoose';
import { z } from 'zod';
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from '../config/constants';

export const paginationQuery = {
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
};

export interface Paginated<T> {
  items: T[];
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

interface PageOptions<T> {
  filter: FilterQuery<T>;
  page: number;
  limit: number;
  sort: Record<string, SortOrder>;
  projection?: string | Record<string, 0 | 1>;
  populate?: { path: string; select: string }[];
}

/**
 * Offset pagination for bounded lists: lean documents, explicit projection and
 * a single parallel count. Sort keys must be backed by an index.
 */
export async function paginate<T>(model: Model<T>, opts: PageOptions<T>): Promise<Paginated<unknown>> {
  const skip = (opts.page - 1) * opts.limit;
  let query = model.find(opts.filter).sort(opts.sort).skip(skip).limit(opts.limit);
  if (opts.projection) query = query.select(opts.projection);
  for (const p of opts.populate ?? []) query = query.populate(p.path, p.select);
  const [items, total] = await Promise.all([query.lean().exec(), model.countDocuments(opts.filter).exec()]);
  return { items, page: opts.page, limit: opts.limit, total, totalPages: Math.max(1, Math.ceil(total / opts.limit)) };
}

/** Aggregation variant: runs data and count in one round trip with $facet. */
export async function paginateAggregate<T>(
  model: Model<T>,
  pipeline: PipelineStage[],
  page: number,
  limit: number,
): Promise<Paginated<unknown>> {
  const [res] = await model
    .aggregate<{ items: unknown[]; total: { n: number }[] }>([
      ...pipeline,
      {
        $facet: {
          items: [{ $skip: (page - 1) * limit }, { $limit: limit }],
          total: [{ $count: 'n' }],
        },
      },
    ])
    .exec();
  const total = res?.total[0]?.n ?? 0;
  return { items: res?.items ?? [], page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) };
}
