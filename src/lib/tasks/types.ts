import type { TaskPriority, TaskStatus } from './rules';

/** Shapes Champ Hub's endpoints return. Shared by server and browser. */

export type PersonRef = { id: string; fullName: string };

export type TaskView = {
	id: string;
	title: string;
	description: string;
	status: TaskStatus;
	priority: TaskPriority;
	dueDate: string | null;
	blocked: boolean;
	assignee: PersonRef | null;
	createdBy: PersonRef;
	/** Waiting for the assignee's lead to approve it, or turned down by them. */
	requestState: 'pending' | 'declined' | null;
	requestNote: string | null;
	/** The lead who approves (or approved) it. */
	approver: PersonRef | null;
	rank: string;
	version: number;
	source:
		| { kind: 'meeting'; meetingId: string; topic: string; date: string; quote: string | null; canOpen: boolean }
		| { kind: 'message'; channelId: string | null; messageId: string | null; quote: string | null; channelName: string | null }
		| null;
	subtasks: { done: number; total: number };
	completedAt: string | null;
	updatedAt: string;
	/** What the viewer may do with it. */
	/** delete: the maker, their leads or a Super Admin; the delete button shows only then. */
	can: { edit: boolean; approve: boolean; delete: boolean };
};

export type TaskDetail = TaskView & {
	subtaskList: { id: string; title: string; done: boolean }[];
	events: { id: string; kind: 'comment' | 'activity'; body: string; actor: PersonRef | null; createdAt: string }[];
	/** People the viewer can pick as assignee, grouped the way the picker shows them. */
	assignable: AssignableGroups;
};

/** Everyone can be given a task; `approval` lists the people whose lead must approve it first. */
export type AssignableGroups = { direct: PersonRef[]; approval: (PersonRef & { approverName: string })[] };

export type MeetingSummary = { overview: string; details: { label: string; text: string }[]; nextSteps: string[] };

export type MeetingItemView = {
	id: string;
	title: string;
	ownerId: string | null;
	ownerName: string | null;
	ownerHeard: string | null;
	dueDate: string | null;
	priority: TaskPriority;
	stepIndex: number | null;
	confidence: number | null;
	included: boolean;
	taskId: string | null;
	/** For the host: 'approval' when the owner's lead must approve the task first. */
	mode: 'direct' | 'approval';
};

export type MeetingRowView = {
	id: string;
	topic: string;
	startedAt: string;
	durationMin: number | null;
	state: 'upcoming' | 'waiting' | 'ready' | 'published' | 'no_summary' | 'cancelled';
	source: 'zoom' | 'pasted';
	host: PersonRef | null;
	attendees: PersonRef[];
	guestCount: number;
	itemCount: number;
	itemsNeedingOwner: number;
	publishedCount: number;
	/** Viewer is the host (or may review for them). */
	isHost: boolean;
	/** Tasks from this meeting that belong to the viewer. */
	mine: { taskId: string; title: string }[];
	/** Scheduled from ESS: people join through /hub/meetings/<id>/join. */
	canJoin: boolean;
	agenda: string | null;
};

export type MeetingView = MeetingRowView & {
	summary: MeetingSummary | null;
	items: MeetingItemView[];
	assignable: AssignableGroups;
	publishedAt: string | null;
};

export type NeedKind = 'approval' | 'minutes' | 'mention' | 'due' | 'blocked';

export type NeedItem = {
	key: string;
	kind: NeedKind;
	title: string;
	detail: string;
	quote?: string | null;
	/** approval: a leave or attendance request, or a task waiting for this lead */
	approval?: { type: 'leave' | 'deviation' | 'comp_off' | 'task'; id: string; stage: 'manager' | 'hr' };
	/** a task approval, due, blocked */
	task?: TaskView;
	/** minutes */
	meetingId?: string;
	/** mention */
	mention?: { channelId: string; messageId: string; channelName: string };
	at: string;
};

export type ChatPreview = { id: string; name: string; kind: string; unread: number; mentions: number; last: string | null; lastAt: string };

export type TodayData = {
	today: string;
	needs: NeedItem[];
	dueThisWeek: TaskView[];
	meetingsToday: MeetingRowView[];
	unreadChats: ChatPreview[];
};

export type TeamLane = { person: PersonRef & { title: string | null }; tasks: TaskView[] };
