import { AppDataSource } from "../db/data-source";
import { Group } from "../db/entities";
import type { EntityManager } from "typeorm";

type Q = EntityManager;

function em(m?: Q): Q {
  return m ?? AppDataSource.manager;
}

export function groupRepo(m?: Q) {
  return em(m).getRepository(Group);
}

export async function findGroupsOrdered(m?: Q): Promise<Group[]> {
  return groupRepo(m).find({ order: { sortOrder: "ASC", name: "ASC" } });
}

export async function findGroupById(id: string, m?: Q): Promise<Group | null> {
  return groupRepo(m).findOneBy({ id });
}

export async function countChildGroups(
  parentId: string,
  m?: Q,
): Promise<number> {
  return groupRepo(m).countBy({ parentId });
}

export async function saveGroup(group: Group, m?: Q): Promise<Group> {
  return groupRepo(m).save(group);
}

export async function deleteGroup(id: string, m?: Q): Promise<void> {
  await groupRepo(m).delete({ id });
}
