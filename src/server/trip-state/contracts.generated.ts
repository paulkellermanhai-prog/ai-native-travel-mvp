/* Generated from immutable Trip State 0.1.0 schemas. Run npm run contracts:generate. Do not edit. */

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

export interface TripStateContracts {
  Candidate: Candidate;
  ChangeRecord: ChangeRecord;
  Constraint: Constraint;
  Decision: Decision;
  DecisionContext: DecisionContext;
  DestinationEntity: DestinationEntity;
  ExternalFact: ExternalFact;
  OpenIssue: OpenIssue;
  OperationIntent: OperationIntent;
  Preference: Preference;
  Skeleton: Skeleton;
  TripGoal: TripGoal;
  "change-request": ChangeRequest;
  command: Command;
  common: Common;
  "confirm-request": ConfirmRequest;
  "context-request": ContextRequest;
  history: History;
  response: Response;
  state: State;
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
export interface ChangeRecord {
  id: string;
  type: "ChangeRecord";
  trip_id: string;
  proposal_id: string;
  intent_id: string;
  outcome: "applied" | "pending_confirmation" | "rejected";
  /**
   * @minItems 1
   *
   * Items: 非空文本
   */
  actions: [string, ...string[]];
  /**
   * 非空文本
   */
  reason: string;
  base_revision: number;
  result_revision: number;
  created_at: string;
  confirmation_actor: string | null;
  /**
   * 非空文本
   */
  request_digest: string;
  /**
   * @minItems 0
   */
  affected_ids: string[];
  effective_before: string | null;
  effective_after: string | null;
  /**
   * @minItems 0
   */
  diff: {
    id: string;
    before:
      | (
          | TripGoal
          | Preference
          | Constraint
          | DestinationEntity
          | Candidate
          | ExternalFact
          | Skeleton
          | Decision
          | OpenIssue
        )
      | null;
    after:
      | (
          | TripGoal
          | Preference
          | Constraint
          | DestinationEntity
          | Candidate
          | ExternalFact
          | Skeleton
          | Decision
          | OpenIssue
        )
      | null;
  }[];
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
export interface OperationIntent {
  id: string;
  type: "OperationIntent";
  trip_id: string;
  actor_id: string;
  actor_role: "user" | "model" | "system" | "tool";
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
  base_revision: number;
  created_at: string;
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
export interface Common {
  [k: string]: unknown;
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
export interface ContextRequest {
  task_id: string;
  /**
   * @minItems 0
   */
  selected_object_ids: string[];
}
export interface History {
  /**
   * @minItems 0
   */
  intents: OperationIntent[];
  /**
   * @minItems 0
   */
  changes: ChangeRecord[];
}
export interface Response {
  outcome: "applied" | "pending_confirmation" | "rejected" | "conflict" | "preview";
  revision: number;
  proposal_id: string | null;
  proposal_digest: string | null;
  confirmation_required: boolean;
  /**
   * @minItems 0
   */
  affected_ids: string[];
  /**
   * @minItems 0
   */
  diff: {
    id: string;
    before:
      | (
          | TripGoal
          | Preference
          | Constraint
          | DestinationEntity
          | Candidate
          | ExternalFact
          | Skeleton
          | Decision
          | OpenIssue
        )
      | null;
    after:
      | (
          | TripGoal
          | Preference
          | Constraint
          | DestinationEntity
          | Candidate
          | ExternalFact
          | Skeleton
          | Decision
          | OpenIssue
        )
      | null;
  }[];
  /**
   * @minItems 0
   */
  errors: {
    /**
     * 非空文本
     */
    code: string;
    /**
     * 非空文本
     */
    message: string;
  }[];
}
export interface State {
  schema_version: "0.1.0";
  trip_id: string;
  revision: number;
  effective_skeleton_id: string | null;
  /**
   * @minItems 0
   */
  objects: (
    TripGoal | Preference | Constraint | DestinationEntity | Candidate | ExternalFact | Skeleton | Decision | OpenIssue
  )[];
}
