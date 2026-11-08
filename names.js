'use strict';
// Tool name for every operation in ClickUp's public API (spec/), keyed by the spec's operationId.
// The generator fails on an operation missing from both maps, so a new ClickUp endpoint is noticed
// on the next spec refresh instead of quietly not existing here.
// Two operations may share a name when they differ only by parent (a list in a folder or folderless
// in a space): the tool takes either parent id and calls the operation whose path it fills.

const NAMES = {
  // ---- workspaces, users, roles ----
  GetAuthorizedTeams: 'clickup_list_workspaces',
  GetWorkspaceplan: 'clickup_get_workspace_plan',
  GetWorkspaceseats: 'clickup_get_workspace_seats',
  GetAuthorizedUser: 'clickup_get_authorized_user',
  SharedHierarchy: 'clickup_get_shared_hierarchy',
  GetCustomRoles: 'clickup_list_custom_roles',
  GetCustomItems: 'clickup_list_custom_task_types',
  InviteUserToWorkspace: 'clickup_invite_user',
  GetUser: 'clickup_get_user',
  EditUserOnWorkspace: 'clickup_update_user',
  RemoveUserFromWorkspace: 'clickup_remove_user',
  GetTeams1: 'clickup_list_user_groups',
  CreateUserGroup: 'clickup_create_user_group',
  UpdateTeam: 'clickup_update_user_group',
  DeleteTeam: 'clickup_delete_user_group',
  InviteGuestToWorkspace: 'clickup_invite_guest',
  GetGuest: 'clickup_get_guest',
  EditGuestOnWorkspace: 'clickup_update_guest',
  RemoveGuestFromWorkspace: 'clickup_remove_guest_from_workspace',
  AddGuestToFolder: 'clickup_add_guest_to_folder',
  RemoveGuestFromFolder: 'clickup_remove_guest_from_folder',
  AddGuestToList: 'clickup_add_guest_to_list',
  RemoveGuestFromList: 'clickup_remove_guest_from_list',
  AddGuestToTask: 'clickup_add_guest_to_task',
  RemoveGuestFromTask: 'clickup_remove_guest_from_task',
  publicPatchAcl: 'clickup_update_acl',
  queryAuditLog: 'clickup_query_audit_logs',

  // ---- spaces ----
  GetSpaces: 'clickup_list_spaces',
  GetSpace: 'clickup_get_space',
  CreateSpace: 'clickup_create_space',
  UpdateSpace: 'clickup_update_space',
  DeleteSpace: 'clickup_delete_space',
  GetSpaceTags: 'clickup_list_space_tags',
  CreateSpaceTag: 'clickup_create_space_tag',
  EditSpaceTag: 'clickup_update_space_tag',
  DeleteSpaceTag: 'clickup_delete_space_tag',

  // ---- folders ----
  GetFolders: 'clickup_list_folders',
  GetFolder: 'clickup_get_folder',
  CreateFolder: 'clickup_create_folder',
  CreateFolderFromTemplate: 'clickup_create_folder_from_template',
  UpdateFolder: 'clickup_update_folder',
  MoveFolder: 'clickup_move_folder',
  DeleteFolder: 'clickup_delete_folder',

  // ---- lists ----
  GetLists: 'clickup_list_lists',
  GetFolderlessLists: 'clickup_list_folderless_lists',
  GetList: 'clickup_get_list',
  CreateList: 'clickup_create_list',
  CreateFolderlessList: 'clickup_create_list',
  CreateFolderListFromTemplate: 'clickup_create_list_from_template',
  CreateSpaceListFromTemplate: 'clickup_create_list_from_template',
  UpdateList: 'clickup_update_list',
  DeleteList: 'clickup_delete_list',
  AddTaskToList: 'clickup_add_task_to_list',
  RemoveTaskFromList: 'clickup_remove_task_from_list',
  GetListMembers: 'clickup_list_list_members',

  // ---- tasks ----
  GetTasks: 'clickup_list_tasks',
  GetFilteredTeamTasks: 'clickup_filter_tasks',
  GetTask: 'clickup_get_task',
  CreateTask: 'clickup_create_task',
  CreateTaskFromTemplate: 'clickup_create_task_from_template',
  UpdateTask: 'clickup_update_task',
  DeleteTask: 'clickup_delete_task',
  moveTask: 'clickup_move_task',
  mergeTasks: 'clickup_merge_tasks',
  GetTaskMembers: 'clickup_list_task_members',
  "GetTask'sTimeinStatus": 'clickup_get_time_in_status',
  "GetBulkTasks'TimeinStatus": 'clickup_get_bulk_time_in_status',
  updateTimeEstimatesByUser: 'clickup_update_time_estimates_by_user',
  replaceTimeEstimatesByUser: 'clickup_replace_time_estimates_by_user',
  AddTagToTask: 'clickup_add_tag_to_task',
  RemoveTagFromTask: 'clickup_remove_tag_from_task',
  AddDependency: 'clickup_add_dependency',
  DeleteDependency: 'clickup_delete_dependency',
  AddTaskLink: 'clickup_add_task_link',
  DeleteTaskLink: 'clickup_delete_task_link',
  CreateChecklist: 'clickup_create_checklist',
  EditChecklist: 'clickup_update_checklist',
  DeleteChecklist: 'clickup_delete_checklist',
  CreateChecklistItem: 'clickup_create_checklist_item',
  EditChecklistItem: 'clickup_update_checklist_item',
  DeleteChecklistItem: 'clickup_delete_checklist_item',
  CreateTaskAttachment: 'clickup_create_task_attachment',

  // ---- custom fields ----
  getTeamAvailableFields: 'clickup_list_workspace_custom_fields',
  getSpaceAvailableFields: 'clickup_list_space_custom_fields',
  getFolderAvailableFields: 'clickup_list_folder_custom_fields',
  GetAccessibleCustomFields: 'clickup_list_list_custom_fields',
  SetCustomFieldValue: 'clickup_set_custom_field_value',
  RemoveCustomFieldValue: 'clickup_remove_custom_field_value',

  // ---- templates ----
  GetTaskTemplates: 'clickup_list_task_templates',
  GetListTemplates: 'clickup_list_list_templates',
  GetFolderTemplates: 'clickup_list_folder_templates',

  // ---- comments ----
  GetTaskComments: 'clickup_list_task_comments',
  CreateTaskComment: 'clickup_create_task_comment',
  GetListComments: 'clickup_list_list_comments',
  CreateListComment: 'clickup_create_list_comment',
  GetChatViewComments: 'clickup_list_view_comments',
  CreateChatViewComment: 'clickup_create_view_comment',
  GetThreadedComments: 'clickup_list_comment_replies',
  CreateThreadedComment: 'clickup_create_comment_reply',
  UpdateComment: 'clickup_update_comment',
  DeleteComment: 'clickup_delete_comment',
  getSubtypes: 'clickup_list_comment_subtypes',

  // ---- views ----
  GetTeamViews: 'clickup_list_workspace_views',
  GetSpaceViews: 'clickup_list_space_views',
  GetFolderViews: 'clickup_list_folder_views',
  GetListViews: 'clickup_list_list_views',
  GetView: 'clickup_get_view',
  GetViewTasks: 'clickup_list_view_tasks',
  CreateTeamView: 'clickup_create_workspace_view',
  CreateSpaceView: 'clickup_create_space_view',
  CreateFolderView: 'clickup_create_folder_view',
  CreateListView: 'clickup_create_list_view',
  UpdateView: 'clickup_update_view',
  DeleteView: 'clickup_delete_view',

  // ---- goals ----
  GetGoals: 'clickup_list_goals',
  GetGoal: 'clickup_get_goal',
  CreateGoal: 'clickup_create_goal',
  UpdateGoal: 'clickup_update_goal',
  DeleteGoal: 'clickup_delete_goal',
  CreateKeyResult: 'clickup_create_key_result',
  EditKeyResult: 'clickup_update_key_result',
  DeleteKeyResult: 'clickup_delete_key_result',

  // ---- time tracking ----
  Gettimeentrieswithinadaterange: 'clickup_list_time_entries',
  Getsingulartimeentry: 'clickup_get_time_entry',
  Gettimeentryhistory: 'clickup_get_time_entry_history',
  Getrunningtimeentry: 'clickup_get_running_time_entry',
  Createatimeentry: 'clickup_create_time_entry',
  UpdateatimeEntry: 'clickup_update_time_entry',
  DeleteatimeEntry: 'clickup_delete_time_entry',
  StartatimeEntry: 'clickup_start_timer',
  StopatimeEntry: 'clickup_stop_timer',
  Getalltagsfromtimeentries: 'clickup_list_time_entry_tags',
  Addtagsfromtimeentries: 'clickup_add_time_entry_tags',
  Changetagnamesfromtimeentries: 'clickup_rename_time_entry_tag',
  Removetagsfromtimeentries: 'clickup_remove_time_entry_tags',
  Gettrackedtime: 'clickup_list_tracked_time_legacy',
  Tracktime: 'clickup_track_time_legacy',
  Edittimetracked: 'clickup_update_tracked_time_legacy',
  Deletetimetracked: 'clickup_delete_tracked_time_legacy',

  // ---- webhooks ----
  GetWebhooks: 'clickup_list_webhooks',
  CreateWebhook: 'clickup_create_webhook',
  UpdateWebhook: 'clickup_update_webhook',
  DeleteWebhook: 'clickup_delete_webhook',

  // ---- docs (v3) ----
  searchDocsPublic: 'clickup_search_docs',
  getDocPublic: 'clickup_get_doc',
  createDocPublic: 'clickup_create_doc',
  getDocPageListingPublic: 'clickup_get_doc_page_listing',
  getDocPagesPublic: 'clickup_list_doc_pages',
  getPagePublic: 'clickup_get_doc_page',
  createPagePublic: 'clickup_create_doc_page',
  editPagePublic: 'clickup_update_doc_page',

  // ---- attachments (v3) ----
  getParentEntityAttachments: 'clickup_list_attachments',
  postEntityAttachment: 'clickup_create_attachment',

  // ---- chat (v3) ----
  getChatChannels: 'clickup_list_chat_channels',
  getChatChannel: 'clickup_get_chat_channel',
  createChatChannel: 'clickup_create_chat_channel',
  createLocationChatChannel: 'clickup_create_location_chat_channel',
  createDirectMessageChatChannel: 'clickup_create_direct_message',
  updateChatChannel: 'clickup_update_chat_channel',
  deleteChatChannel: 'clickup_delete_chat_channel',
  getChatChannelFollowers: 'clickup_list_chat_channel_followers',
  getChatChannelMembers: 'clickup_list_chat_channel_members',
  getChatMessages: 'clickup_list_chat_messages',
  createChatMessage: 'clickup_send_chat_message',
  patchChatMessage: 'clickup_update_chat_message',
  deleteChatMessage: 'clickup_delete_chat_message',
  getChatMessageReplies: 'clickup_list_chat_replies',
  createReplyMessage: 'clickup_send_chat_reply',
  getChatMessageReactions: 'clickup_list_chat_reactions',
  createChatReaction: 'clickup_add_chat_reaction',
  deleteChatReaction: 'clickup_delete_chat_reaction',
  getChatMessageTaggedUsers: 'clickup_list_chat_tagged_users',
};

// Operations deliberately left out, with the reason.
const EXCLUDED = {
  GetAccessToken: 'OAuth code exchange for third-party apps; this server authenticates with personal tokens.',
};

module.exports = { NAMES, EXCLUDED };
