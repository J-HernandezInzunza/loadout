// Where the host REST APIs live (architecture.md §5.5). Production always uses the defaults; tests
// pass the local stub's bases instead (§6), so nothing in a test can reach a real host.

export interface ApiBases {
  /** GitHub REST, e.g. `${github}/user` */
  github: string;
  /** Bitbucket Cloud REST 2.0, e.g. `${bitbucket}/user` */
  bitbucket: string;
  /** Bitbucket OAuth, e.g. `${bitbucketAuth}/access_token` */
  bitbucketAuth: string;
}

export const defaultApiBases: ApiBases = {
  github: "https://api.github.com",
  bitbucket: "https://api.bitbucket.org/2.0",
  bitbucketAuth: "https://bitbucket.org/site/oauth2",
};
