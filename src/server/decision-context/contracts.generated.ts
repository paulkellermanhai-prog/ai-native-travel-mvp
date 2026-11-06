/* Generated from Gate A accepted R6. Run npm run dc:generate. Do not edit. */

export type Command =
  | {
      op: "create";
      object_type: "TripGoal";
      id: string;
      scope:
        | {
            kind: "trip" | "entity" | "skeleton" | "traveler";
            /**
             * @minItems 0
             */
            ids: string[];
          }
        | {
            kind: "date";
            /**
             * @minItems 0
             * @maxItems 0
             */
            ids: string[];
            start: string;
            end: string;
          };
      /**
       * @minItems 0
       */
      dependencies: {
        object_id: string;
        version: number;
        /**
         * @minItems 0
         */
        paths: string[];
        relation: "input" | "evidence" | "association";
      }[];
      data: {
        /**
         * @minItems 0
         */
        destination_ids: string[];
        /**
         * 非空文本
         */
        purpose: string;
        /**
         * 非空文本
         */
        success_definition: string;
        /**
         * @minItems 0
         */
        traveler_ids: string[];
        /**
         * 非空文本
         */
        current_task: string;
      };
    }
  | {
      op: "create";
      object_type: "Preference";
      id: string;
      scope:
        | {
            kind: "trip" | "entity" | "skeleton" | "traveler";
            /**
             * @minItems 0
             */
            ids: string[];
          }
        | {
            kind: "date";
            /**
             * @minItems 0
             * @maxItems 0
             */
            ids: string[];
            start: string;
            end: string;
          };
      /**
       * @minItems 0
       */
      dependencies: {
        object_id: string;
        version: number;
        /**
         * @minItems 0
         */
        paths: string[];
        relation: "input" | "evidence" | "association";
      }[];
      data: {
        /**
         * @minItems 0
         */
        subject_ids: string[];
        /**
         * 非空文本
         */
        aspect: string;
        polarity: "positive" | "negative" | "tradeoff";
        certainty: "explicit" | "inferred" | "ambiguous" | "unknown";
        support: "weak" | "supported";
        priority: "ordinary" | "important" | "critical";
        /**
         * 非空文本
         */
        expression: string;
        condition:
          | {
              op: "always";
            }
          | {
              op: "all" | "any";
              /**
               * @minItems 1
               */
              args: [Condition, ...Condition[]];
            }
          | {
              op: "not";
              arg: Condition;
            }
          | {
              op: "eq" | "ne" | "lt" | "lte" | "gt" | "gte";
              object_id: string;
              path: string;
              value: string | number | boolean | null;
            };
        /**
         * @minItems 0
         *
         * Items: 非空文本
         */
        evidence_refs: string[];
      };
    }
  | {
      op: "create";
      object_type: "Constraint";
      id: string;
      scope:
        | {
            kind: "trip" | "entity" | "skeleton" | "traveler";
            /**
             * @minItems 0
             */
            ids: string[];
          }
        | {
            kind: "date";
            /**
             * @minItems 0
             * @maxItems 0
             */
            ids: string[];
            start: string;
            end: string;
          };
      /**
       * @minItems 0
       */
      dependencies: {
        object_id: string;
        version: number;
        /**
         * @minItems 0
         */
        paths: string[];
        relation: "input" | "evidence" | "association";
      }[];
      data: {
        hardness: "soft" | "hard";
        override_policy: "user" | "fixed";
        value:
          | {
              kind: "budget";
              mode: "intent" | "range" | "ceiling";
              minimum_minor: number | null;
              maximum_minor: number | null;
              currency: string;
              people: number;
              /**
               * @minItems 0
               *
               * Items: 非空文本
               */
              categories: string[];
            }
          | {
              kind: "date_window";
              start: string;
              end: string;
            }
          | {
              kind: "duration";
              maximum_nights: number;
            }
          | {
              kind: "travelers";
              count: number;
            }
          | {
              kind: "entry_exit";
              entry_entity_id: string;
              exit_entity_id: string;
              arrival: string | null;
              departure: string | null;
            }
          | {
              kind: "requirement";
              /**
               * 非空文本
               */
              description: string;
              condition:
                | {
                    op: "always";
                  }
                | {
                    op: "all" | "any";
                    /**
                     * @minItems 1
                     */
                    args: [Condition, ...Condition[]];
                  }
                | {
                    op: "not";
                    arg: Condition;
                  }
                | {
                    op: "eq" | "ne" | "lt" | "lte" | "gt" | "gte";
                    object_id: string;
                    path: string;
                    value: string | number | boolean | null;
                  };
            };
      };
    }
  | {
      op: "create";
      object_type: "DestinationEntity";
      id: string;
      scope:
        | {
            kind: "trip" | "entity" | "skeleton" | "traveler";
            /**
             * @minItems 0
             */
            ids: string[];
          }
        | {
            kind: "date";
            /**
             * @minItems 0
             * @maxItems 0
             */
            ids: string[];
            start: string;
            end: string;
          };
      /**
       * @minItems 0
       */
      dependencies: {
        object_id: string;
        version: number;
        /**
         * @minItems 0
         */
        paths: string[];
        relation: "input" | "evidence" | "association";
      }[];
      data: {
        entity_kind: "country" | "city" | "region" | "experience" | "transport_node";
        /**
         * 非空文本
         */
        name: string;
        parent_id: string | null;
        geo_identity: string | null;
        /**
         * @minItems 0
         *
         * Items: 非空文本
         */
        knowledge_refs: string[];
        coverage: "unknown" | "partial" | "covered";
      };
    }
  | {
      op: "create";
      object_type: "Candidate";
      id: string;
      scope:
        | {
            kind: "trip" | "entity" | "skeleton" | "traveler";
            /**
             * @minItems 0
             */
            ids: string[];
          }
        | {
            kind: "date";
            /**
             * @minItems 0
             * @maxItems 0
             */
            ids: string[];
            start: string;
            end: string;
          };
      /**
       * @minItems 0
       */
      dependencies: {
        object_id: string;
        version: number;
        /**
         * @minItems 0
         */
        paths: string[];
        relation: "input" | "evidence" | "association";
      }[];
      data: {
        /**
         * @minItems 0
         */
        subject_ids: string[];
        candidate_kind: "city" | "experience" | "connection" | "combination";
        inclusion_reason: string | null;
        exclusion_reason: string | null;
        reconsider_when:
          | {
              op: "always";
            }
          | {
              op: "all" | "any";
              /**
               * @minItems 1
               */
              args: [Condition, ...Condition[]];
            }
          | {
              op: "not";
              arg: Condition;
            }
          | {
              op: "eq" | "ne" | "lt" | "lte" | "gt" | "gte";
              object_id: string;
              path: string;
              value: string | number | boolean | null;
            };
        /**
         * @minItems 0
         */
        preference_ids: string[];
        /**
         * @minItems 0
         */
        issue_ids: string[];
      };
    }
  | {
      op: "create";
      object_type: "Skeleton";
      id: string;
      scope:
        | {
            kind: "trip" | "entity" | "skeleton" | "traveler";
            /**
             * @minItems 0
             */
            ids: string[];
          }
        | {
            kind: "date";
            /**
             * @minItems 0
             * @maxItems 0
             */
            ids: string[];
            start: string;
            end: string;
          };
      /**
       * @minItems 0
       */
      dependencies: {
        object_id: string;
        version: number;
        /**
         * @minItems 0
         */
        paths: string[];
        relation: "input" | "evidence" | "association";
      }[];
      data: {
        purpose: "scenario" | "plan";
        /**
         * @minItems 1
         */
        stops: [
          {
            entity_id: string;
            nights: number | null;
          },
          ...{
            entity_id: string;
            nights: number | null;
          }[]
        ];
        /**
         * @minItems 0
         */
        connections: {
          from_id: string;
          to_id: string;
          /**
           * @minItems 0
           */
          fact_ids: string[];
        }[];
        /**
         * @minItems 0
         */
        cost_fact_ids: string[];
        parent_id: string | null;
        /**
         * @minItems 0
         */
        overrides: {
          constraint_id: string;
          value:
            | {
                kind: "budget";
                mode: "intent" | "range" | "ceiling";
                minimum_minor: number | null;
                maximum_minor: number | null;
                currency: string;
                people: number;
                /**
                 * @minItems 0
                 *
                 * Items: 非空文本
                 */
                categories: string[];
              }
            | {
                kind: "date_window";
                start: string;
                end: string;
              }
            | {
                kind: "duration";
                maximum_nights: number;
              }
            | {
                kind: "travelers";
                count: number;
              }
            | {
                kind: "entry_exit";
                entry_entity_id: string;
                exit_entity_id: string;
                arrival: string | null;
                departure: string | null;
              }
            | {
                kind: "requirement";
                /**
                 * 非空文本
                 */
                description: string;
                condition:
                  | {
                      op: "always";
                    }
                  | {
                      op: "all" | "any";
                      /**
                       * @minItems 1
                       */
                      args: [Condition, ...Condition[]];
                    }
                  | {
                      op: "not";
                      arg: Condition;
                    }
                  | {
                      op: "eq" | "ne" | "lt" | "lte" | "gt" | "gte";
                      object_id: string;
                      path: string;
                      value: string | number | boolean | null;
                    };
              };
        }[];
        tradeoffs: {
          /**
           * @minItems 0
           *
           * Items: 非空文本
           */
          gains: string[];
          /**
           * @minItems 0
           *
           * Items: 非空文本
           */
          losses: string[];
        };
      };
    }
  | {
      op: "create";
      object_type: "OpenIssue";
      id: string;
      scope:
        | {
            kind: "trip" | "entity" | "skeleton" | "traveler";
            /**
             * @minItems 0
             */
            ids: string[];
          }
        | {
            kind: "date";
            /**
             * @minItems 0
             * @maxItems 0
             */
            ids: string[];
            start: string;
            end: string;
          };
      /**
       * @minItems 0
       */
      dependencies: {
        object_id: string;
        version: number;
        /**
         * @minItems 0
         */
        paths: string[];
        relation: "input" | "evidence" | "association";
      }[];
      data: {
        issue_kind: "missing" | "conflict" | "verification" | "dependency" | "unsupported";
        /**
         * 非空文本
         */
        question: string;
        /**
         * @minItems 0
         */
        affected_ids: string[];
        severity: "info" | "warning" | "blocking";
        /**
         * @minItems 0
         *
         * Items: 非空文本
         */
        required_inputs: string[];
        /**
         * @minItems 0
         */
        candidate_actions: ("clarify" | "verify" | "calculate" | "compare" | "confirm")[];
        owner: "user" | "system" | "provider";
        resolution: string | null;
        /**
         * @minItems 0
         */
        evidence_ids: string[];
      };
    }
  | {
      op: "revise";
      object_type: "TripGoal";
      id: string;
      changes: {
        /**
         * 非空文本
         */
        purpose?: string;
        /**
         * 非空文本
         */
        success_definition?: string;
        /**
         * @minItems 0
         */
        destination_ids?: string[];
        /**
         * 非空文本
         */
        current_task?: string;
      };
    }
  | {
      op: "revise";
      object_type: "Preference";
      id: string;
      changes: {
        /**
         * @minItems 0
         */
        subject_ids?: string[];
        /**
         * 非空文本
         */
        aspect?: string;
        polarity?: "positive" | "negative" | "tradeoff";
        certainty?: "explicit" | "inferred" | "ambiguous" | "unknown";
        support?: "weak" | "supported";
        priority?: "ordinary" | "important" | "critical";
        /**
         * 非空文本
         */
        expression?: string;
        condition?:
          | {
              op: "always";
            }
          | {
              op: "all" | "any";
              /**
               * @minItems 1
               */
              args: [Condition, ...Condition[]];
            }
          | {
              op: "not";
              arg: Condition;
            }
          | {
              op: "eq" | "ne" | "lt" | "lte" | "gt" | "gte";
              object_id: string;
              path: string;
              value: string | number | boolean | null;
            };
        /**
         * @minItems 0
         *
         * Items: 非空文本
         */
        evidence_refs?: string[];
      };
    }
  | {
      op: "revise";
      object_type: "Constraint";
      id: string;
      changes: {
        value?:
          | {
              kind: "budget";
              mode: "intent" | "range" | "ceiling";
              minimum_minor: number | null;
              maximum_minor: number | null;
              currency: string;
              people: number;
              /**
               * @minItems 0
               *
               * Items: 非空文本
               */
              categories: string[];
            }
          | {
              kind: "date_window";
              start: string;
              end: string;
            }
          | {
              kind: "duration";
              maximum_nights: number;
            }
          | {
              kind: "travelers";
              count: number;
            }
          | {
              kind: "entry_exit";
              entry_entity_id: string;
              exit_entity_id: string;
              arrival: string | null;
              departure: string | null;
            }
          | {
              kind: "requirement";
              /**
               * 非空文本
               */
              description: string;
              condition:
                | {
                    op: "always";
                  }
                | {
                    op: "all" | "any";
                    /**
                     * @minItems 1
                     */
                    args: [Condition, ...Condition[]];
                  }
                | {
                    op: "not";
                    arg: Condition;
                  }
                | {
                    op: "eq" | "ne" | "lt" | "lte" | "gt" | "gte";
                    object_id: string;
                    path: string;
                    value: string | number | boolean | null;
                  };
            };
        hardness?: "soft" | "hard";
      };
    }
  | {
      op: "revise";
      object_type: "DestinationEntity";
      id: string;
      changes: {
        /**
         * 非空文本
         */
        name?: string;
        geo_identity?: string | null;
        /**
         * @minItems 0
         *
         * Items: 非空文本
         */
        knowledge_refs?: string[];
        coverage?: "unknown" | "partial" | "covered";
      };
    }
  | {
      op: "revise";
      object_type: "Candidate";
      id: string;
      changes: {
        inclusion_reason?: string | null;
        exclusion_reason?: string | null;
        reconsider_when?:
          | {
              op: "always";
            }
          | {
              op: "all" | "any";
              /**
               * @minItems 1
               */
              args: [Condition, ...Condition[]];
            }
          | {
              op: "not";
              arg: Condition;
            }
          | {
              op: "eq" | "ne" | "lt" | "lte" | "gt" | "gte";
              object_id: string;
              path: string;
              value: string | number | boolean | null;
            };
        /**
         * @minItems 0
         */
        preference_ids?: string[];
        /**
         * @minItems 0
         */
        issue_ids?: string[];
      };
    }
  | {
      op: "revise";
      object_type: "Skeleton";
      id: string;
      changes: {
        /**
         * @minItems 1
         */
        stops?: [
          {
            entity_id: string;
            nights: number | null;
          },
          ...{
            entity_id: string;
            nights: number | null;
          }[]
        ];
        /**
         * @minItems 0
         */
        connections?: {
          from_id: string;
          to_id: string;
          /**
           * @minItems 0
           */
          fact_ids: string[];
        }[];
        /**
         * @minItems 0
         */
        cost_fact_ids?: string[];
        tradeoffs?: {
          /**
           * @minItems 0
           *
           * Items: 非空文本
           */
          gains: string[];
          /**
           * @minItems 0
           *
           * Items: 非空文本
           */
          losses: string[];
        };
        /**
         * @minItems 0
         */
        overrides?: {
          constraint_id: string;
          value:
            | {
                kind: "budget";
                mode: "intent" | "range" | "ceiling";
                minimum_minor: number | null;
                maximum_minor: number | null;
                currency: string;
                people: number;
                /**
                 * @minItems 0
                 *
                 * Items: 非空文本
                 */
                categories: string[];
              }
            | {
                kind: "date_window";
                start: string;
                end: string;
              }
            | {
                kind: "duration";
                maximum_nights: number;
              }
            | {
                kind: "travelers";
                count: number;
              }
            | {
                kind: "entry_exit";
                entry_entity_id: string;
                exit_entity_id: string;
                arrival: string | null;
                departure: string | null;
              }
            | {
                kind: "requirement";
                /**
                 * 非空文本
                 */
                description: string;
                condition:
                  | {
                      op: "always";
                    }
                  | {
                      op: "all" | "any";
                      /**
                       * @minItems 1
                       */
                      args: [Condition, ...Condition[]];
                    }
                  | {
                      op: "not";
                      arg: Condition;
                    }
                  | {
                      op: "eq" | "ne" | "lt" | "lte" | "gt" | "gte";
                      object_id: string;
                      path: string;
                      value: string | number | boolean | null;
                    };
              };
        }[];
      };
    }
  | {
      op: "revise";
      object_type: "OpenIssue";
      id: string;
      changes: {
        /**
         * 非空文本
         */
        question?: string;
        /**
         * @minItems 0
         *
         * Items: 非空文本
         */
        required_inputs?: string[];
        /**
         * @minItems 0
         */
        candidate_actions?: ("clarify" | "verify" | "calculate" | "compare" | "confirm")[];
        owner?: "user" | "system" | "provider";
      };
    }
  | {
      op: "transition";
      id: string;
      event:
        | "activate"
        | "archive"
        | "close"
        | "confirm"
        | "contradict"
        | "dismiss"
        | "exclude"
        | "exclude_conditionally"
        | "invalidate"
        | "make_actionable"
        | "reconsider"
        | "relax"
        | "release"
        | "reopen"
        | "request_confirmation"
        | "resolve"
        | "restore"
        | "retain"
        | "retire"
        | "revise"
        | "revoke"
        | "supersede"
        | "wait"
        | "withdraw";
    }
  | {
      op: "adopt_skeleton";
      id: string;
      acknowledge_unknowns: boolean;
      /**
       * @minItems 4
       */
      confirmation_scope: [
        "cities" | "order" | "stays" | "connections",
        "cities" | "order" | "stays" | "connections",
        "cities" | "order" | "stays" | "connections",
        "cities" | "order" | "stays" | "connections",
        ...("cities" | "order" | "stays" | "connections")[]
      ];
    }
  | {
      op: "decide_candidate";
      id: string;
      value: "accept" | "reject" | "retain";
    }
  | {
      op: "reconsider";
      id: string;
      trigger_id: string;
    }
  | {
      op: "recalculate";
      id: string;
    }
  | {
      op: "check_freshness";
    }
  | {
      op: "resolve_issue";
      id: string;
      /**
       * 非空文本
       */
      reason: string;
      /**
       * @minItems 0
       */
      evidence_ids: string[];
    }
  | {
      op: "dismiss_issue";
      id: string;
      /**
       * 非空文本
       */
      reason: string;
    }
  | {
      op: "withdraw_decision";
      id: string;
    }
  | {
      op: "ingest_fact";
      id: string;
      scope:
        | {
            kind: "trip" | "entity" | "skeleton" | "traveler";
            /**
             * @minItems 0
             */
            ids: string[];
          }
        | {
            kind: "date";
            /**
             * @minItems 0
             * @maxItems 0
             */
            ids: string[];
            start: string;
            end: string;
          };
      /**
       * @minItems 0
       */
      dependencies: {
        object_id: string;
        version: number;
        /**
         * @minItems 0
         */
        paths: string[];
        relation: "input" | "evidence" | "association";
      }[];
      data: {
        /**
         * @minItems 0
         */
        subject_ids: string[];
        query: {
          date: string | null;
          /**
           * @minItems 0
           */
          parameters: {
            /**
             * 非空文本
             */
            name: string;
            value: string | number | boolean | null;
          }[];
        };
        /**
         * 非空文本
         */
        provider: string;
        query_status: "result" | "partial" | "empty" | "timeout" | "error" | "no_service";
        observed_at: string;
        expires_at: string;
        valid_for: {
          start: string;
          end: string;
        };
        /**
         * @minItems 0
         *
         * Items: 非空文本
         */
        missing_fields: string[];
        value:
          | null
          | {
              kind: "transport";
              from_id: string;
              to_id: string;
              departure: string | null;
              arrival: string | null;
              duration_minutes: number | null;
              service_exists: boolean | null;
            }
          | {
              kind: "cost";
              amount_minor: number;
              currency: string;
              people: number;
              /**
               * 非空文本
               */
              category: string;
              /**
               * 费用项去重键
               */
              item_key: string;
            }
          | {
              kind: "condition";
              value: boolean | null;
              /**
               * 非空文本
               */
              description: string;
            };
      };
    };
export type Condition =
  | {
      op: "always";
    }
  | {
      op: "all" | "any";
      /**
       * @minItems 1
       */
      args: [Condition, ...Condition[]];
    }
  | {
      op: "not";
      arg: Condition;
    }
  | {
      op: "eq" | "ne" | "lt" | "lte" | "gt" | "gte";
      object_id: string;
      path: string;
      value: string | number | boolean | null;
    };

export interface DecisionContextContracts {
  assemble: Assemble;
  change: Change;
  "checkpoint-payload": CheckpointPayload;
  confirm: Confirm;
  error: Error;
  "open-turn": OpenTurn;
  packet: Packet;
  "page-request": PageRequest;
  page: Page;
  "scene-ack": SceneAck;
  "scene-delete": SceneDelete;
  "scene-list-result": SceneListResult;
  "scene-list": SceneList;
  "scene-restore": SceneRestore;
  "scene-restored": SceneRestored;
  "scene-retry": SceneRetry;
  "scene-save": SceneSave;
  "scene-status-result": SceneStatusResult;
  "scene-status": SceneStatus;
  turn: Turn;
}
export interface Assemble {
  runtime_contract_version: "0.1.0";
  turn_id: string;
  task_key: string;
  body_budget_bytes: number;
}
export interface Change {
  runtime_contract_version: "0.1.0";
  turn_id: string;
  packet_id: string;
  request: ChangeRequest;
}
export interface ChangeRequest {
  expected_revision: number;
  /**
   * 非空文本
   */
  idempotency_key: string;
  /**
   * 非空文本
   */
  reason: string;
  input: {
    kind: "dialogue" | "map" | "timeline" | "tool" | "system";
    /**
     * 非空文本
     */
    reference: string;
    /**
     * 非空文本
     */
    text: string;
    /**
     * @minItems 0
     */
    target_ids: string[];
  };
  /**
   * @minItems 1
   */
  commands: [Command, ...Command[]];
}
export interface CheckpointPayload {
  checkpoint_format_version: 1;
  trip_id: string;
  captured_state_revision: number;
  /**
   * @minItems 0
   */
  captured_object_versions: {
    id: string;
    version: number;
  }[];
  /**
   * @minItems 0
   * @maxItems 128
   */
  tasks: {
    task: Task;
    event: Event;
    base_revision: number;
    processing_status: "unprocessed" | "proposed" | "pending_confirmation" | "applied" | "rejected" | "conflict";
    result_revision: number;
    /**
     * @minItems 0
     */
    errors: {
      code: string;
      message: string;
    }[];
  }[];
  /**
   * @minItems 0
   */
  focus_keys: string[];
  view: View;
  /**
   * @minItems 0
   * @maxItems 20
   */
  drafts: Draft[];
  /**
   * @minItems 0
   */
  deferred_issue_ids: string[];
}
export interface Task {
  task_key: string;
  question: string;
  kind: "explore" | "candidate_tradeoff" | "skeleton_choice" | "constraint_adjustment";
  /**
   * @minItems 0
   */
  target_ids: string[];
  branch: "actual" | "hypothetical";
  relation: "new" | "continue" | "refine" | "resume" | "reopen" | "focus";
  /**
   * @minItems 0
   */
  related_task_keys: string[];
  certainty: "explicit" | "inferred" | "ambiguous";
  /**
   * @minItems 1
   */
  evidence: [Span, ...Span[]];
  progress: "open" | "paused" | "handled";
  progress_evidence: Span | null;
}
export interface Span {
  start: number;
  end: number;
  quote: string;
}
export interface Event {
  event_id: string;
  entry: "dialogue" | "map" | "timeline" | "comparison";
  text: string;
  reference: string;
  received_at: string;
}
export interface View {
  entry: "dialogue" | "map" | "timeline" | "comparison";
  /**
   * @minItems 0
   */
  comparison_refs: {
    id: string;
    version: number;
  }[];
  selected_id: string | null;
  /**
   * @minItems 0
   */
  expanded_task_keys: string[];
}
export interface Draft {
  draft_id: string;
  draft_kind: "unsubmitted" | "hypothetical";
  base_revision: number;
  /**
   * @minItems 0
   */
  target_ids: string[];
  text: string;
  source_reference: string;
  proposal: ChangeRequest | null;
}
export interface Confirm {
  runtime_contract_version: "0.1.0";
  turn_id: string;
  proposal_id: string;
  request: ConfirmRequest;
}
export interface ConfirmRequest {
  expected_revision: number;
  /**
   * 非空文本
   */
  idempotency_key: string;
  /**
   * 非空文本
   */
  proposal_digest: string;
  accept: boolean;
}
export interface Error {
  runtime_contract_version: "0.1.0";
  code: string;
  message: string;
  retryable: boolean;
}
export interface OpenTurn {
  runtime_contract_version: "0.1.0";
  trip_id: string;
  expected_revision: number;
  event: Event1;
  /**
   * @minItems 1
   */
  tasks: [Task1, ...Task1[]];
  /**
   * @minItems 1
   */
  focus_keys: [string, ...string[]];
}
export interface Event1 {
  event_id: string;
  entry: "dialogue" | "map" | "timeline" | "comparison";
  text: string;
  reference: string;
  received_at: string;
}
export interface Task1 {
  task_key: string;
  question: string;
  kind: "explore" | "candidate_tradeoff" | "skeleton_choice" | "constraint_adjustment";
  /**
   * @minItems 0
   */
  target_ids: string[];
  branch: "actual" | "hypothetical";
  relation: "new" | "continue" | "refine" | "resume" | "reopen" | "focus";
  /**
   * @minItems 0
   */
  related_task_keys: string[];
  certainty: "explicit" | "inferred" | "ambiguous";
  /**
   * @minItems 1
   */
  evidence: [Span1, ...Span1[]];
  progress: "open" | "paused" | "handled";
  progress_evidence: Span1 | null;
}
export interface Span1 {
  start: number;
  end: number;
  quote: string;
}
export interface Packet {
  runtime_contract_version: "0.1.0";
  packet_id: string;
  turn_id: string;
  task: Task2;
  context: DecisionContext;
  pending_input: Pending;
  /**
   * @minItems 0
   */
  objects: (
    TripGoal | Preference | Constraint | DestinationEntity | Candidate | ExternalFact | Skeleton | Decision | OpenIssue
  )[];
  /**
   * @minItems 0
   */
  deferred_ids: string[];
  coverage: "complete" | "layered" | "limited";
  evidence_checked_at: string;
  snapshot_digest: string;
  /**
   * @minItems 0
   */
  annotations: Annotation[];
  support: "decision_support" | "information_only";
  /**
   * @minItems 0
   */
  warnings: string[];
}
export interface Task2 {
  task_key: string;
  question: string;
  kind: "explore" | "candidate_tradeoff" | "skeleton_choice" | "constraint_adjustment";
  /**
   * @minItems 0
   */
  target_ids: string[];
  branch: "actual" | "hypothetical";
  relation: "new" | "continue" | "refine" | "resume" | "reopen" | "focus";
  /**
   * @minItems 0
   */
  related_task_keys: string[];
  certainty: "explicit" | "inferred" | "ambiguous";
  /**
   * @minItems 1
   */
  evidence: [Span2, ...Span2[]];
  progress: "open" | "paused" | "handled";
  progress_evidence: Span2 | null;
}
export interface Span2 {
  start: number;
  end: number;
  quote: string;
}
export interface DecisionContext {
  id: string;
  type: "DecisionContext";
  trip_id: string;
  task_id: string;
  status: "assembled" | "active" | "stale" | "released";
  state_revision: number;
  assembled_at: string;
  expires_at: string;
  /**
   * @minItems 0
   */
  selected_object_ids: string[];
  /**
   * @minItems 0
   */
  must_include_constraints: string[];
  /**
   * @minItems 0
   */
  active_decisions: string[];
  /**
   * @minItems 0
   */
  open_issues: string[];
  /**
   * @minItems 0
   */
  relevant_facts: string[];
  /**
   * @minItems 0
   */
  assembled_from_versions: {
    id: string;
    version: number;
  }[];
  /**
   * @minItems 0
   */
  stale_fact_ids: string[];
}
export interface Pending {
  event: Event2;
  base_revision: number;
  processing_status: "unprocessed" | "proposed" | "pending_confirmation" | "applied" | "rejected" | "conflict";
  proposal_id: string | null;
  result_revision: number;
  /**
   * @minItems 0
   */
  errors: {
    code: string;
    message: string;
  }[];
}
export interface Event2 {
  event_id: string;
  entry: "dialogue" | "map" | "timeline" | "comparison";
  text: string;
  reference: string;
  received_at: string;
}
export interface TripGoal {
  id: string;
  trip_id: string;
  type: "TripGoal";
  version: number;
  status: "draft" | "active" | "revised" | "closed";
  scope:
    | {
        kind: "trip" | "entity" | "skeleton" | "traveler";
        /**
         * @minItems 0
         */
        ids: string[];
      }
    | {
        kind: "date";
        /**
         * @minItems 0
         * @maxItems 0
         */
        ids: string[];
        start: string;
        end: string;
      };
  source: {
    actor: "user" | "model" | "system" | "tool";
    actor_id: string;
    /**
     * 输入或适配器证据标识
     */
    reference: string;
    /**
     * 原始表达或结果摘要
     */
    text: string;
    at: string;
  };
  /**
   * @minItems 0
   */
  dependencies: {
    object_id: string;
    version: number;
    /**
     * @minItems 0
     */
    paths: string[];
    relation: "input" | "evidence" | "association";
  }[];
  updated_at: string;
  /**
   * @minItems 0
   */
  destination_ids: string[];
  /**
   * 非空文本
   */
  purpose: string;
  /**
   * 非空文本
   */
  success_definition: string;
  /**
   * @minItems 0
   */
  traveler_ids: string[];
  /**
   * 非空文本
   */
  current_task: string;
}
export interface Preference {
  id: string;
  trip_id: string;
  type: "Preference";
  version: number;
  status: "active" | "superseded" | "withdrawn";
  scope:
    | {
        kind: "trip" | "entity" | "skeleton" | "traveler";
        /**
         * @minItems 0
         */
        ids: string[];
      }
    | {
        kind: "date";
        /**
         * @minItems 0
         * @maxItems 0
         */
        ids: string[];
        start: string;
        end: string;
      };
  source: {
    actor: "user" | "model" | "system" | "tool";
    actor_id: string;
    /**
     * 输入或适配器证据标识
     */
    reference: string;
    /**
     * 原始表达或结果摘要
     */
    text: string;
    at: string;
  };
  /**
   * @minItems 0
   */
  dependencies: {
    object_id: string;
    version: number;
    /**
     * @minItems 0
     */
    paths: string[];
    relation: "input" | "evidence" | "association";
  }[];
  updated_at: string;
  /**
   * @minItems 0
   */
  subject_ids: string[];
  /**
   * 非空文本
   */
  aspect: string;
  polarity: "positive" | "negative" | "tradeoff";
  certainty: "explicit" | "inferred" | "ambiguous" | "unknown";
  support: "weak" | "supported";
  priority: "ordinary" | "important" | "critical";
  /**
   * 非空文本
   */
  expression: string;
  condition:
    | {
        op: "always";
      }
    | {
        op: "all" | "any";
        /**
         * @minItems 1
         */
        args: [Condition, ...Condition[]];
      }
    | {
        op: "not";
        arg: Condition;
      }
    | {
        op: "eq" | "ne" | "lt" | "lte" | "gt" | "gte";
        object_id: string;
        path: string;
        value: string | number | boolean | null;
      };
  /**
   * @minItems 0
   *
   * Items: 非空文本
   */
  evidence_refs: string[];
}
export interface Constraint {
  id: string;
  trip_id: string;
  type: "Constraint";
  version: number;
  status: "proposed" | "active" | "relaxed" | "invalidated";
  scope:
    | {
        kind: "trip" | "entity" | "skeleton" | "traveler";
        /**
         * @minItems 0
         */
        ids: string[];
      }
    | {
        kind: "date";
        /**
         * @minItems 0
         * @maxItems 0
         */
        ids: string[];
        start: string;
        end: string;
      };
  source: {
    actor: "user" | "model" | "system" | "tool";
    actor_id: string;
    /**
     * 输入或适配器证据标识
     */
    reference: string;
    /**
     * 原始表达或结果摘要
     */
    text: string;
    at: string;
  };
  /**
   * @minItems 0
   */
  dependencies: {
    object_id: string;
    version: number;
    /**
     * @minItems 0
     */
    paths: string[];
    relation: "input" | "evidence" | "association";
  }[];
  updated_at: string;
  hardness: "soft" | "hard";
  override_policy: "user" | "fixed";
  value:
    | {
        kind: "budget";
        mode: "intent" | "range" | "ceiling";
        minimum_minor: number | null;
        maximum_minor: number | null;
        currency: string;
        people: number;
        /**
         * @minItems 0
         *
         * Items: 非空文本
         */
        categories: string[];
      }
    | {
        kind: "date_window";
        start: string;
        end: string;
      }
    | {
        kind: "duration";
        maximum_nights: number;
      }
    | {
        kind: "travelers";
        count: number;
      }
    | {
        kind: "entry_exit";
        entry_entity_id: string;
        exit_entity_id: string;
        arrival: string | null;
        departure: string | null;
      }
    | {
        kind: "requirement";
        /**
         * 非空文本
         */
        description: string;
        condition:
          | {
              op: "always";
            }
          | {
              op: "all" | "any";
              /**
               * @minItems 1
               */
              args: [Condition, ...Condition[]];
            }
          | {
              op: "not";
              arg: Condition;
            }
          | {
              op: "eq" | "ne" | "lt" | "lte" | "gt" | "gte";
              object_id: string;
              path: string;
              value: string | number | boolean | null;
            };
      };
}
export interface DestinationEntity {
  id: string;
  trip_id: string;
  type: "DestinationEntity";
  version: number;
  status: "known" | "retired";
  scope:
    | {
        kind: "trip" | "entity" | "skeleton" | "traveler";
        /**
         * @minItems 0
         */
        ids: string[];
      }
    | {
        kind: "date";
        /**
         * @minItems 0
         * @maxItems 0
         */
        ids: string[];
        start: string;
        end: string;
      };
  source: {
    actor: "user" | "model" | "system" | "tool";
    actor_id: string;
    /**
     * 输入或适配器证据标识
     */
    reference: string;
    /**
     * 原始表达或结果摘要
     */
    text: string;
    at: string;
  };
  /**
   * @minItems 0
   */
  dependencies: {
    object_id: string;
    version: number;
    /**
     * @minItems 0
     */
    paths: string[];
    relation: "input" | "evidence" | "association";
  }[];
  updated_at: string;
  entity_kind: "country" | "city" | "region" | "experience" | "transport_node";
  /**
   * 非空文本
   */
  name: string;
  parent_id: string | null;
  geo_identity: string | null;
  /**
   * @minItems 0
   *
   * Items: 非空文本
   */
  knowledge_refs: string[];
  coverage: "unknown" | "partial" | "covered";
}
export interface Candidate {
  id: string;
  trip_id: string;
  type: "Candidate";
  version: number;
  status: "exploring" | "retained" | "conditionally_excluded" | "excluded" | "reintroduced";
  scope:
    | {
        kind: "trip" | "entity" | "skeleton" | "traveler";
        /**
         * @minItems 0
         */
        ids: string[];
      }
    | {
        kind: "date";
        /**
         * @minItems 0
         * @maxItems 0
         */
        ids: string[];
        start: string;
        end: string;
      };
  source: {
    actor: "user" | "model" | "system" | "tool";
    actor_id: string;
    /**
     * 输入或适配器证据标识
     */
    reference: string;
    /**
     * 原始表达或结果摘要
     */
    text: string;
    at: string;
  };
  /**
   * @minItems 0
   */
  dependencies: {
    object_id: string;
    version: number;
    /**
     * @minItems 0
     */
    paths: string[];
    relation: "input" | "evidence" | "association";
  }[];
  updated_at: string;
  /**
   * @minItems 0
   */
  subject_ids: string[];
  candidate_kind: "city" | "experience" | "connection" | "combination";
  inclusion_reason: string | null;
  exclusion_reason: string | null;
  reconsider_when:
    | {
        op: "always";
      }
    | {
        op: "all" | "any";
        /**
         * @minItems 1
         */
        args: [Condition, ...Condition[]];
      }
    | {
        op: "not";
        arg: Condition;
      }
    | {
        op: "eq" | "ne" | "lt" | "lte" | "gt" | "gte";
        object_id: string;
        path: string;
        value: string | number | boolean | null;
      };
  /**
   * @minItems 0
   */
  preference_ids: string[];
  /**
   * @minItems 0
   */
  issue_ids: string[];
  review_state: "current" | "stale";
}
export interface ExternalFact {
  id: string;
  trip_id: string;
  type: "ExternalFact";
  version: number;
  status: "active" | "superseded" | "contradicted";
  scope:
    | {
        kind: "trip" | "entity" | "skeleton" | "traveler";
        /**
         * @minItems 0
         */
        ids: string[];
      }
    | {
        kind: "date";
        /**
         * @minItems 0
         * @maxItems 0
         */
        ids: string[];
        start: string;
        end: string;
      };
  source: {
    actor: "user" | "model" | "system" | "tool";
    actor_id: string;
    /**
     * 输入或适配器证据标识
     */
    reference: string;
    /**
     * 原始表达或结果摘要
     */
    text: string;
    at: string;
  };
  /**
   * @minItems 0
   */
  dependencies: {
    object_id: string;
    version: number;
    /**
     * @minItems 0
     */
    paths: string[];
    relation: "input" | "evidence" | "association";
  }[];
  updated_at: string;
  /**
   * @minItems 0
   */
  subject_ids: string[];
  query: {
    date: string | null;
    /**
     * @minItems 0
     */
    parameters: {
      /**
       * 非空文本
       */
      name: string;
      value: string | number | boolean | null;
    }[];
  };
  /**
   * 非空文本
   */
  provider: string;
  query_status: "result" | "partial" | "empty" | "timeout" | "error" | "no_service";
  verification: "unverified" | "estimated" | "date_specific" | "purchasable";
  freshness: "current" | "stale";
  applicability: "applicable" | "unknown" | "not_applicable";
  observed_at: string;
  expires_at: string;
  valid_for: {
    start: string;
    end: string;
  };
  /**
   * @minItems 0
   *
   * Items: 非空文本
   */
  missing_fields: string[];
  value:
    | null
    | {
        kind: "transport";
        from_id: string;
        to_id: string;
        departure: string | null;
        arrival: string | null;
        duration_minutes: number | null;
        service_exists: boolean | null;
      }
    | {
        kind: "cost";
        amount_minor: number;
        currency: string;
        people: number;
        /**
         * 非空文本
         */
        category: string;
        /**
         * 费用项去重键
         */
        item_key: string;
      }
    | {
        kind: "condition";
        value: boolean | null;
        /**
         * 非空文本
         */
        description: string;
      };
}
export interface Skeleton {
  id: string;
  trip_id: string;
  type: "Skeleton";
  version: number;
  status: "active" | "superseded" | "archived";
  scope:
    | {
        kind: "trip" | "entity" | "skeleton" | "traveler";
        /**
         * @minItems 0
         */
        ids: string[];
      }
    | {
        kind: "date";
        /**
         * @minItems 0
         * @maxItems 0
         */
        ids: string[];
        start: string;
        end: string;
      };
  source: {
    actor: "user" | "model" | "system" | "tool";
    actor_id: string;
    /**
     * 输入或适配器证据标识
     */
    reference: string;
    /**
     * 原始表达或结果摘要
     */
    text: string;
    at: string;
  };
  /**
   * @minItems 0
   */
  dependencies: {
    object_id: string;
    version: number;
    /**
     * @minItems 0
     */
    paths: string[];
    relation: "input" | "evidence" | "association";
  }[];
  updated_at: string;
  purpose: "scenario" | "plan";
  /**
   * @minItems 1
   */
  stops: [
    {
      entity_id: string;
      nights: number | null;
    },
    ...{
      entity_id: string;
      nights: number | null;
    }[]
  ];
  /**
   * @minItems 0
   */
  connections: {
    from_id: string;
    to_id: string;
    /**
     * @minItems 0
     */
    fact_ids: string[];
  }[];
  /**
   * @minItems 0
   */
  cost_fact_ids: string[];
  parent_id: string | null;
  /**
   * @minItems 0
   */
  overrides: {
    constraint_id: string;
    value:
      | {
          kind: "budget";
          mode: "intent" | "range" | "ceiling";
          minimum_minor: number | null;
          maximum_minor: number | null;
          currency: string;
          people: number;
          /**
           * @minItems 0
           *
           * Items: 非空文本
           */
          categories: string[];
        }
      | {
          kind: "date_window";
          start: string;
          end: string;
        }
      | {
          kind: "duration";
          maximum_nights: number;
        }
      | {
          kind: "travelers";
          count: number;
        }
      | {
          kind: "entry_exit";
          entry_entity_id: string;
          exit_entity_id: string;
          arrival: string | null;
          departure: string | null;
        }
      | {
          kind: "requirement";
          /**
           * 非空文本
           */
          description: string;
          condition:
            | {
                op: "always";
              }
            | {
                op: "all" | "any";
                /**
                 * @minItems 1
                 */
                args: [Condition, ...Condition[]];
              }
            | {
                op: "not";
                arg: Condition;
              }
            | {
                op: "eq" | "ne" | "lt" | "lte" | "gt" | "gte";
                object_id: string;
                path: string;
                value: string | number | boolean | null;
              };
        };
  }[];
  tradeoffs: {
    /**
     * @minItems 0
     *
     * Items: 非空文本
     */
    gains: string[];
    /**
     * @minItems 0
     *
     * Items: 非空文本
     */
    losses: string[];
  };
  assessment: {
    status: "unchecked" | "pending" | "verified" | "blocked" | "stale";
    total_nights: number | null;
    /**
     * @minItems 0
     */
    connection_minutes: (number | null)[];
    /**
     * @minItems 0
     */
    cost_groups: {
      /**
       * 非空文本
       */
      currency: string;
      people: number;
      subtotal_minor: number;
      /**
       * @minItems 0
       */
      fact_ids: string[];
    }[];
    cost_coverage: "partial" | "none";
    /**
     * @minItems 0
     *
     * Items: 非空文本
     */
    unknowns: string[];
    /**
     * @minItems 0
     *
     * Items: 非空文本
     */
    violations: string[];
    checked_at: string | null;
  };
}
export interface Decision {
  id: string;
  trip_id: string;
  type: "Decision";
  version: number;
  status: "proposed" | "pending_confirmation" | "confirmed" | "revised" | "revoked";
  scope:
    | {
        kind: "trip" | "entity" | "skeleton" | "traveler";
        /**
         * @minItems 0
         */
        ids: string[];
      }
    | {
        kind: "date";
        /**
         * @minItems 0
         * @maxItems 0
         */
        ids: string[];
        start: string;
        end: string;
      };
  source: {
    actor: "user" | "model" | "system" | "tool";
    actor_id: string;
    /**
     * 输入或适配器证据标识
     */
    reference: string;
    /**
     * 原始表达或结果摘要
     */
    text: string;
    at: string;
  };
  /**
   * @minItems 0
   */
  dependencies: {
    object_id: string;
    version: number;
    /**
     * @minItems 0
     */
    paths: string[];
    relation: "input" | "evidence" | "association";
  }[];
  updated_at: string;
  subject_id: string;
  subject_version: number;
  decision_kind: "adopt_skeleton" | "candidate_choice";
  value: "accept" | "reject" | "retain";
  /**
   * @minItems 0
   *
   * Items: 非空文本
   */
  confirmation_scope: string[];
  /**
   * @minItems 0
   */
  basis_ids: string[];
  /**
   * @minItems 0
   *
   * Items: 非空文本
   */
  acknowledged_unknowns: string[];
  confirmed_by: string | null;
  confirmed_at: string | null;
  supersedes: string | null;
  review_state: "current" | "stale";
}
export interface OpenIssue {
  id: string;
  trip_id: string;
  type: "OpenIssue";
  version: number;
  status: "open" | "actionable" | "waiting" | "resolved" | "dismissed";
  scope:
    | {
        kind: "trip" | "entity" | "skeleton" | "traveler";
        /**
         * @minItems 0
         */
        ids: string[];
      }
    | {
        kind: "date";
        /**
         * @minItems 0
         * @maxItems 0
         */
        ids: string[];
        start: string;
        end: string;
      };
  source: {
    actor: "user" | "model" | "system" | "tool";
    actor_id: string;
    /**
     * 输入或适配器证据标识
     */
    reference: string;
    /**
     * 原始表达或结果摘要
     */
    text: string;
    at: string;
  };
  /**
   * @minItems 0
   */
  dependencies: {
    object_id: string;
    version: number;
    /**
     * @minItems 0
     */
    paths: string[];
    relation: "input" | "evidence" | "association";
  }[];
  updated_at: string;
  issue_kind: "missing" | "conflict" | "verification" | "dependency" | "unsupported";
  /**
   * 非空文本
   */
  question: string;
  /**
   * @minItems 0
   */
  affected_ids: string[];
  severity: "info" | "warning" | "blocking";
  /**
   * @minItems 0
   *
   * Items: 非空文本
   */
  required_inputs: string[];
  /**
   * @minItems 0
   */
  candidate_actions: ("clarify" | "verify" | "calculate" | "compare" | "confirm")[];
  owner: "user" | "system" | "provider";
  resolution: string | null;
  /**
   * @minItems 0
   */
  evidence_ids: string[];
}
export interface Annotation {
  id: string;
  retained: boolean;
  applicability: "applicable" | "not_applicable" | "unknown";
  restriction: "none" | "decision_limit" | "known_conflict";
  presentation: "policy_judgment" | "suppressed_unchanged" | "limitation_if_used";
  /**
   * @minItems 0
   */
  reason_codes: string[];
  /**
   * @minItems 0
   */
  evidence_ids: string[];
}
export interface PageRequest {
  runtime_contract_version: "0.1.0";
  packet_id: string;
  /**
   * @minItems 1
   */
  object_ids: [string, ...string[]];
}
export interface Page {
  runtime_contract_version: "0.1.0";
  packet_id: string;
  state_revision: number;
  /**
   * @minItems 0
   */
  objects: (
    TripGoal | Preference | Constraint | DestinationEntity | Candidate | ExternalFact | Skeleton | Decision | OpenIssue
  )[];
  /**
   * @minItems 0
   */
  remaining_ids: string[];
  delivery_only_not_model_comprehension: true;
}
export interface SceneAck {
  runtime_contract_version: "0.1.0";
  ack: Ack;
}
export interface Ack {
  workspace_key: string;
  checkpoint_revision: number;
  saved_at: string;
  expires_at: string | null;
  payload_digest: string | null;
  durable: true;
  deleted: boolean;
}
export interface SceneDelete {
  runtime_contract_version: "0.1.0";
  workspace_key: string;
  expected_checkpoint_revision: number;
  idempotency_key: string;
}
export interface SceneListResult {
  runtime_contract_version: "0.1.0";
  /**
   * @minItems 0
   */
  checkpoints: {
    workspace_key: string;
    checkpoint_revision: number;
    saved_at: string;
    expires_at: string | null;
    available: boolean;
  }[];
}
export interface SceneList {
  runtime_contract_version: "0.1.0";
}
export interface SceneRestore {
  runtime_contract_version: "0.1.0";
  workspace_key: string;
  body_budget_bytes: number;
}
export interface SceneRestored {
  runtime_contract_version: "0.1.0";
  workspace_key: string;
  checkpoint_revision: number;
  runtime_id: string;
  saved_state_revision: number;
  current_state_revision: number;
  saved_at: string;
  view: View1;
  /**
   * @minItems 0
   */
  drafts: Draft1[];
  /**
   * @minItems 0
   */
  focus_keys: string[];
  /**
   * @minItems 0
   */
  restored_turns: {
    task_key: string;
    turn_id: string;
  }[];
  /**
   * @minItems 0
   */
  packets: Packet[];
  /**
   * @minItems 0
   */
  warnings: string[];
  /**
   * @minItems 0
   */
  stale_draft_ids: string[];
  /**
   * @minItems 0
   */
  missing_target_ids: string[];
  /**
   * @minItems 0
   */
  stale_comparison_ids: string[];
  /**
   * @minItems 0
   */
  deferred_issue_ids: string[];
  /**
   * @minItems 0
   */
  reopened_issue_ids: string[];
  recovery_requires_new_authorization: true;
}
export interface View1 {
  entry: "dialogue" | "map" | "timeline" | "comparison";
  /**
   * @minItems 0
   */
  comparison_refs: {
    id: string;
    version: number;
  }[];
  selected_id: string | null;
  /**
   * @minItems 0
   */
  expanded_task_keys: string[];
}
export interface Draft1 {
  draft_id: string;
  draft_kind: "unsubmitted" | "hypothetical";
  base_revision: number;
  /**
   * @minItems 0
   */
  target_ids: string[];
  text: string;
  source_reference: string;
  proposal: ChangeRequest | null;
}
export interface SceneRetry {
  runtime_contract_version: "0.1.0";
}
export interface SceneSave {
  runtime_contract_version: "0.1.0";
  workspace_key: string;
  expected_checkpoint_revision: number;
  idempotency_key: string;
  /**
   * @minItems 0
   */
  focus_keys: string[];
  view: View2;
  /**
   * @minItems 0
   * @maxItems 20
   */
  drafts: Draft2[];
}
export interface View2 {
  entry: "dialogue" | "map" | "timeline" | "comparison";
  /**
   * @minItems 0
   */
  comparison_refs: {
    id: string;
    version: number;
  }[];
  selected_id: string | null;
  /**
   * @minItems 0
   */
  expanded_task_keys: string[];
}
export interface Draft2 {
  draft_id: string;
  draft_kind: "unsubmitted" | "hypothetical";
  base_revision: number;
  /**
   * @minItems 0
   */
  target_ids: string[];
  text: string;
  source_reference: string;
  proposal: ChangeRequest | null;
}
export interface SceneStatusResult {
  runtime_contract_version: "0.1.0";
  recovery_available: boolean;
  last_acknowledged_revision: number;
  current_checkpoint_revision: number;
  save_pending: boolean;
  last_error: string | null;
}
export interface SceneStatus {
  runtime_contract_version: "0.1.0";
}
export interface Turn {
  runtime_contract_version: "0.1.0";
  runtime_id: string;
  turn_id: string;
  revision: number;
  /**
   * @minItems 1
   */
  tasks: [Task3, ...Task3[]];
  /**
   * @minItems 1
   */
  focus_keys: [string, ...string[]];
  checkpoint_ack: Ack1 | null;
}
export interface Task3 {
  task_key: string;
  question: string;
  kind: "explore" | "candidate_tradeoff" | "skeleton_choice" | "constraint_adjustment";
  /**
   * @minItems 0
   */
  target_ids: string[];
  branch: "actual" | "hypothetical";
  relation: "new" | "continue" | "refine" | "resume" | "reopen" | "focus";
  /**
   * @minItems 0
   */
  related_task_keys: string[];
  certainty: "explicit" | "inferred" | "ambiguous";
  /**
   * @minItems 1
   */
  evidence: [Span3, ...Span3[]];
  progress: "open" | "paused" | "handled";
  progress_evidence: Span3 | null;
}
export interface Span3 {
  start: number;
  end: number;
  quote: string;
}
export interface Ack1 {
  workspace_key: string;
  checkpoint_revision: number;
  saved_at: string;
  expires_at: string | null;
  payload_digest: string | null;
  durable: true;
  deleted: boolean;
}
