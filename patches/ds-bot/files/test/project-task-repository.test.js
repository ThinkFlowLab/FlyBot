import assert from 'node:assert/strict'
import { test } from 'node:test'
import { taskRepository, attemptProject } from '../src/host/project-task-repository.js'

test('Task bindings reject foreign, removed and replaced associations and preserve historical identity', () => {
  const project = { id: 'p', repository: 'org/one', defaultBranch: 'main', repositoriesVersion: 1 }
  const task = { id: 't', projectId: 'p', projectTaskKind: 'code' }
  const link = { id: 'link', projectId: 'p', repository: 'org/two', defaultBranch: 'dev', createdAt: 1 }
  const rt = { state: { tasks: { t: task }, projectRepositories: { link }, projectAttempts: {} } }
  const selected = taskRepository(rt, project, task, { repository: 'org/two' })
  assert.equal(selected.project.repository, 'org/two')
  assert.equal(project.repository, 'org/one')
  assert.equal(selected.project.defaultBranch, 'dev')
  const attempt = { id: 'a', taskId: 't', projectId: 'p', repositoryBinding: selected.binding, requirement: { repository: 'org/two' } }
  assert.equal(attemptProject(rt, project, attempt).repository, 'org/two')
  assert.throws(() => taskRepository(rt, project, task, { repositoryBinding: { ...selected.binding, projectId: 'foreign' } }), /Foreign/)
  delete rt.state.projectRepositories.link
  assert.throws(() => attemptProject(rt, project, attempt), /not currently associated/)
  rt.state.projectRepositories.link = { ...link, createdAt: 2 }
  assert.throws(() => attemptProject(rt, project, attempt), /association changed/)
  assert.equal(attempt.requirement.repository, 'org/two')
  for (const repository of [null, 'other/repo', '../escape', 3]) assert.throws(() => taskRepository(rt, project, task, { repository }))
  task.projectTaskKind = 'decision'
  assert.equal(taskRepository(rt, project, task, { repository: null }).project.executionKind, 'decision')
  task.projectTask = { requirements: { repository: 'org/two' } }
  assert.throws(() => taskRepository(rt, project, task, { repository: 'org/one' }), /admitted Task/)
})
