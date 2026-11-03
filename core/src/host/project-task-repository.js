// Resolve a Task's execution scope without mutating the Project default.
import { ownEntry } from './store.js'
const fail = message => Object.assign(new Error(message), { code: 'bot/repository-config' })
export function taskRepository(rt, project, task, { repository, repositoryBinding } = {}) {
  const previous = ownEntry(rt.state.projectAttempts ?? {}, task.deliveryAttemptId)
  const retained = previous?.taskId === task.id && previous.projectId === project.id ? previous.requirement?.repository : undefined
  if (repository !== undefined && task.projectTask?.requirements.repository !== undefined && repository !== task.projectTask.requirements.repository) throw fail('Execution repository differs from the admitted Task requirements')
  const selected = repositoryBinding ? repositoryBinding.repository : repository !== undefined ? repository : task.projectTask?.requirements.repository !== undefined ? task.projectTask.requirements.repository : retained !== undefined ? retained : project.repository || null
  if (repositoryBinding && repositoryBinding.projectId !== project.id) throw fail('Foreign Task repository binding')
  if (selected === null) {
    if (task.projectTaskKind !== 'decision') throw fail('Code and release Tasks require an associated repository')
    return { project: { ...project, repository: null, executionKind: 'decision' }, binding: { projectId: project.id, repository: null, kind: 'decision' } }
  }
  if (typeof selected !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(selected)) throw fail('Task repository must be owner/name')
  const association = Object.values(rt.state.projectRepositories ?? {}).find(row => row.projectId === project.id && row.repository === selected)
  // Unmigrated legacy fixtures retain their exact original primary repository.
  if (!association && (project.repositoriesVersion === 1 || selected !== project.repository)) throw fail('Task repository is not currently associated with this Project')
  const binding = { projectId: project.id, repository: selected, defaultBranch: association?.defaultBranch ?? project.defaultBranch, associationId: association?.id ?? null, associatedAt: association?.createdAt ?? null }
  if (repositoryBinding && Object.keys(binding).some(key => binding[key] !== repositoryBinding[key])) throw fail('Task repository association changed; explicit recovery is required')
  return { project: { ...project, repository: selected, defaultBranch: binding.defaultBranch }, binding }
}
export function attemptProject(rt, project, attempt) {
  const task = ownEntry(rt.state.tasks, attempt.taskId)
  if (!task || task.projectId !== project.id || attempt.projectId !== project.id) throw fail('Foreign execution repository')
  return taskRepository(rt, project, task, attempt.repositoryBinding ? { repositoryBinding: attempt.repositoryBinding } : { repository: attempt.requirement.repository ?? null }).project
}
